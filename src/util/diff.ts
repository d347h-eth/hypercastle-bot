export function shallowDiff<T extends Record<string, unknown>>(
    a: Partial<T>,
    b: Partial<T>,
): Record<string, { from: unknown; to: unknown }> {
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
        const av = (a as any)[key];
        const bv = (b as any)[key];
        if (av !== bv) {
            diff[key] = { from: av, to: bv };
        }
    }
    return diff;
}
