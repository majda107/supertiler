export function filterPoints(featureCollection) {
    const points = featureCollection?.features?.filter(feature => feature?.geometry?.type == 'Point') ?? [];

    return {
        type: "FeatureCollection",
        features: points
    };
}