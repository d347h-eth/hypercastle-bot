export function computeBackoffSeconds(attempts: number): number {
    // 1m,2m,4m,... capped at 30m
    const base = Math.pow(2, attempts) * 60;
    return Math.min(30 * 60, base || 60);
}
