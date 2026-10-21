function count(value) {
    return Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
}

export function summarizeParserVisionReports(reports = []) {
    const phases = (Array.isArray(reports) ? reports : [])
        .filter((report) => report && typeof report === 'object')
        .map((report, index) => ({
            phase: `phase-${index + 1}`,
            requests: count(report.totalRequests),
            completedRequests: count(report.completedRequests),
            failedRequests: count(report.failedRequests),
            cacheHits: count(report.cacheHits),
            images: {
                planned: count(report.images?.planned),
                recognized: count(report.images?.recognized),
                announcements: count(report.images?.announcements),
                unprocessed: count(report.images?.unprocessed),
            },
        }));
    const total = phases.reduce((sum, phase) => ({
        requests: sum.requests + phase.requests,
        completedRequests: sum.completedRequests + phase.completedRequests,
        failedRequests: sum.failedRequests + phase.failedRequests,
        cacheHits: sum.cacheHits + phase.cacheHits,
        planned: sum.planned + phase.images.planned,
        recognized: sum.recognized + phase.images.recognized,
        announcements: sum.announcements + phase.images.announcements,
        unprocessed: sum.unprocessed + phase.images.unprocessed,
    }), { requests: 0, completedRequests: 0, failedRequests: 0, cacheHits: 0, planned: 0, recognized: 0, announcements: 0, unprocessed: 0 });
    return {
        phases,
        requests: total.requests,
        completedRequests: total.completedRequests,
        failedRequests: total.failedRequests,
        cacheHits: total.cacheHits,
        images: {
            planned: total.planned,
            recognized: total.recognized,
            announcements: total.announcements,
            unprocessed: total.unprocessed,
        },
    };
}
