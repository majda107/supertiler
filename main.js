import readline from "readline";
import events from "events";

import Supercluster from 'supercluster';
import Sqlite from 'sqlite';
import VTpbf from 'vt-pbf';
import { gzip } from 'node-gzip';
import { performance } from 'perf_hooks';
import fs from 'fs';


let featureCollection = {
    type: 'FeatureCollection',
    features: []
};

async function readInput(options) {
    const rl = readline.createInterface({
        input: fs.createReadStream(options.input),
        crlfDelay: Infinity
    });

    let foundFeatures = false;
    rl.on('line', line => {

        if (foundFeatures) {
            try {
                if (line.endsWith(',')) line = line.slice(0, -1);

                const feature = JSON.parse(line);
                featureCollection.features.push(feature);
            } catch { }
        }

        if (line.includes("features")) {
            foundFeatures = true;
        }
    });

    await events.once(rl, 'close');
}



const defaultOptions = {
    // For Supercluster
    minZoom: 0,   // min zoom to generate clusters on
    maxZoom: 8,   // max zoom level to cluster the points on
    radius: 40,   // cluster radius in pixels
    extent: 512,  // tile extent (radius is calculated relative to it)
    nodeSize: 64, // size of the KD-tree leaf node, affects performance
    log: false,   // whether to log timing info
    // a reduce function for calculating custom cluster properties
    reduce: null, // (accumulated, props) => { accumulated.sum += props.sum; }
    // properties to use for individual points when running the reducer
    map: props => props, // props => ({sum: props.my_value})
    storeClusterExpansionZoom: false,

    // For mbtiles
    bounds: '-180.0,-85,180,85',
    center: '0,0,0',
    tileSpecVersion: 2,

    layer: "geojsonLayer",
    inputGeometryFilter: (g) => g,
    geometryMapper: undefined,

    minPoints: 2,

    readByLine: false,
    gzipSynchronously: false
};

function extend(dest, src) {
    for (const id in src) dest[id] = src[id];
    return dest;
}

export default async function (options) {
    options = extend(Object.create(defaultOptions), options);

    if (options.readByLine) {
        await readInput(options);
    } else {
        featureCollection = JSON.parse(fs.readFileSync(options.input));
    }


    const clustered = new Supercluster({
        minZoom: options.minZoom,
        maxZoom: options.maxZoom,
        radius: options.radius,
        extent: options.extent,
        nodeSize: options.nodeSize,
        map: options.map,
        reduce: options.reduce,
        minPoints: options.minPoints
    }).load(featureCollection.features.filter(options.inputGeometryFilter));

    if (options.logPerformance) {
        console.log(`Finished clustering at ${performance.now()}`);
    }
    if (fs.existsSync(options.output)) {
        // Clear previous MBTiles, if it exists
        fs.unlinkSync(options.output);
    }
    const filter = options.filter;
    return Sqlite.open(options.output, { Promise }).then(db => Promise.all([
        db.run('CREATE TABLE metadata (name text, value text)'),
        db.run('CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)')
    ]).then(async () => {
        // Build metadata table
        db.run('INSERT INTO metadata (name, value) VALUES ("name", ?)', options.output);
        db.run('INSERT INTO metadata (name, value) VALUES ("format", "pbf")');
        db.run('INSERT INTO metadata (name, value) VALUES ("minZoom", ?)', options.minZoom);
        db.run('INSERT INTO metadata (name, value) VALUES ("maxZoom", ?)', options.maxZoom + (options.includeUnclustered ? 1 : 0));
        db.run('INSERT INTO metadata (name, value) VALUES ("bounds", ?)', options.bounds);
        db.run('INSERT INTO metadata (name, value) VALUES ("center", ?)', options.center);
        db.run('INSERT INTO metadata (name, value) VALUES ("type", "overlay")'); // See MBTiles spec: I think "overlay" is most appropriate here
        db.run('INSERT INTO metadata (name, value) VALUES ("version", ?)', options.tileSpecVersion);
        if (options.attribution) {
            db.run('INSERT INTO metadata (name, value) VALUES ("attribution", ?)', options.attribution);
        }
        if (options.description) {
            db.run('INSERT INTO metadata (name, value) VALUES ("description", ?)', options.description);
        }

        const fields = {};
        const statements = [];
        const compressedTiles = [];
        // Insert tiles
        for (let z = options.minZoom; z <= options.maxZoom + (options.includeUnclustered ? 1 : 0); z++) {
            const zoomDimension = Math.pow(2, z);

            if (options.logPerformance) {
                console.log("PROCESSING ZOOM DIMENSION", zoomDimension, `${z} from ${options.maxZoom + (options.includeUnclustered ? 1 : 0) - 1}`);
            }


            // TODO: No need to process tiles outside of bounds
            // TODO: Stop zoom descent for tiles that don't have any clusters
            for (let x = 0; x < zoomDimension; x++) {
                for (let y = 0; y < zoomDimension; y++) {
                    const tile = clustered.getTile(z, x, y);
                    if (!tile || !tile.features) {
                        // Don't serialize empty tiles
                        continue;
                    }
                    // Apply feature filter
                    if (filter) {
                        tile.features = tile.features.filter(feature => filter(feature.tags));
                    }

                    if (tile.features.length === 0) {
                        // Don't serialize empty tiles (after our custom feature filter)
                        continue;
                    }

                    // Collect field information for metadata
                    for (const feature of tile.features) {
                        for (const property in feature.tags) {
                            fields[property] = typeof feature.tags[property];
                        }
                    }
                    if (options.storeClusterExpansionZoom) {
                        for (const feature of tile.features) {
                            if (feature.tags.cluster_id) {
                                feature.tags['clusterExpansionZoom'] = clustered.getClusterExpansionZoom(feature.tags.cluster_id);
                            }
                        }
                    }

                    const layerObject = {};
                    layerObject[options.layer] = tile;

                    if (options.geometryMapper) {
                        const cleanFeatures = tile.features.filter(f => !f.tags.cluster);
                        const mappedFeatures = options.geometryMapper(cleanFeatures, featureCollection.features);

                        tile.features.push(...mappedFeatures);
                    }

                    if (options.logPerformance && !options.gzipSynchronously) {
                        console.log(`Creating tile ${x} ${y} ${z}`);
                    }

                    // Convert to PBF and compress before insertion
                    // compressedTiles.push(
                    const compressionWorker = (async () => {
                        const compressed = await gzip(VTpbf.fromGeojsonVt(layerObject, { version: options.tileSpecVersion, extent: options.extent }));

                        if (compressed.length > 500000) {
                            // return Promise.reject(new Error(`Tile z:${z}, x:${x}, y:${y} greater than 500KB compressed. Try increasing radius or max zoom, or try including fewer cluster properties.`));
                            console.log(`Warning, compressed length exceeded 500000! (${compressed.length})`);
                        }
                        statements.push(
                            db.run(
                                'INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES(?, ?, ?, ?)',
                                z, x, zoomDimension - 1 - y, compressed));

                        if (options.logPerformance && options.gzipSynchronously) {
                            console.log(`[${z}] Tile ${x} ${y} ${z} created`);
                        }
                    })();
                    // );

                    if (options.gzipSynchronously) {
                        await compressionWorker;
                    } else {
                        compressedTiles.push(compressionWorker);
                    }
                }
            }
        }

        // Complete metadata table by adding layer definition
        const vectorJson = {
            'vector_layers':
                [{
                    'id': options.layer,
                    'description': 'Point layer imported from GeoJSON.',
                    fields
                }]
        };
        statements.push(
            db.run('INSERT INTO metadata (name, value) VALUES ("json", ?)', JSON.stringify(vectorJson)));

        return Promise.all(compressedTiles).then(() => {

            if (options.logPerformance) {
                console.log("Finished saving all compressed tiles.");
            }

            return Promise.all(statements).then(() => {
                // TODO include stats?
                if (options.logPerformance) {
                    console.log(`Finished generating MBTiles at ${performance.now()}.`);
                }
            })
        });
    }));
}
