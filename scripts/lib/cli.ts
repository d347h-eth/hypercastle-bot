export type FlagSpec = {
    name: string;
    short?: string;
    value?: boolean;
};

export type ParsedArgs = {
    positionals: string[];
    options: Record<string, string | boolean>;
};

export function parseArgs(argv: string[], specs: FlagSpec[]): ParsedArgs {
    const byLong = new Map(specs.map((spec) => [spec.name, spec]));
    const byShort = new Map(
        specs
            .filter((spec) => spec.short)
            .map((spec) => [spec.short as string, spec]),
    );
    const positionals: string[] = [];
    const options: Record<string, string | boolean> = {};

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--") {
            positionals.push(...argv.slice(i + 1));
            break;
        }
        if (arg.startsWith("--")) {
            const eq = arg.indexOf("=");
            const rawName = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
            const spec = byLong.get(rawName);
            if (!spec) {
                throw new Error(`Unknown option --${rawName}`);
            }
            if (spec.value) {
                const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
                if (value === undefined) {
                    throw new Error(`Missing value for --${rawName}`);
                }
                options[spec.name] = value;
            } else {
                options[spec.name] = true;
            }
            continue;
        }
        if (arg.startsWith("-") && arg !== "-") {
            const rawName = arg.slice(1);
            const spec = byShort.get(rawName);
            if (!spec) {
                throw new Error(`Unknown option -${rawName}`);
            }
            if (spec.value) {
                const value = argv[++i];
                if (value === undefined) {
                    throw new Error(`Missing value for -${rawName}`);
                }
                options[spec.name] = value;
            } else {
                options[spec.name] = true;
            }
            continue;
        }
        positionals.push(arg);
    }

    return { positionals, options };
}

export function getStringOption(
    parsed: ParsedArgs,
    name: string,
): string | undefined {
    const value = parsed.options[name];
    return typeof value === "string" ? value : undefined;
}

export function getBooleanOption(parsed: ParsedArgs, name: string): boolean {
    return parsed.options[name] === true;
}

export function parseBigIntOption(
    name: string,
    value: string | undefined,
): bigint | undefined {
    if (value === undefined || value === "") return undefined;
    if (!/^\d+$/.test(value.trim())) {
        throw new Error(`${name} must be a non-negative integer`);
    }
    return BigInt(value);
}

export function parsePositiveIntegerOption(
    name: string,
    value: string | undefined,
): number | undefined {
    if (value === undefined || value === "") return undefined;
    if (!/^\d+$/.test(value.trim())) {
        throw new Error(`${name} must be a positive integer`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

export function parsePositiveNumberOption(
    name: string,
    value: string | undefined,
): number | undefined {
    if (value === undefined || value === "") return undefined;
    if (!/^\d+(\.\d+)?$/.test(value.trim())) {
        throw new Error(`${name} must be a positive number`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive number`);
    }
    return parsed;
}

export function requireSinglePositional(
    parsed: ParsedArgs,
    name: string,
): string {
    if (parsed.positionals.length !== 1) {
        throw new Error(`Expected exactly one ${name}`);
    }
    return parsed.positionals[0];
}
