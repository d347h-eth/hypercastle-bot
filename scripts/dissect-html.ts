import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    getBooleanOption,
    getStringOption,
    parseArgs,
    requireSinglePositional,
    type FlagSpec,
} from "./lib/cli.js";

type Cell = {
    className: string;
    text: string;
};

type FontArtifact = {
    index: number;
    source: string;
    family: string | undefined;
    fileName: string;
    format: string;
    base64Length: number;
    byteLength: number;
    codepoints: Set<number> | undefined;
};

type RuntimeAnalysis = {
    constants: ScriptConstants;
    flags: ModeFlags;
    classIds: string[];
    initialGrid: {
        cells: number;
        heightCounts: Record<string, number>;
        uniqueChars: string[];
        uniqueClasses: string[];
        allCellsHeightZero: boolean;
    };
    fontStack: string[];
    biomeCore: string[];
    biomeCoreAfterAntenna: string[];
    coreCharsetLength: number;
    uni: number[];
    selectedUni: {
        index: number | undefined;
        value: number | undefined;
        reason: string;
    };
    blade: {
        computed: boolean;
        engaged: boolean;
        index: number | undefined;
        uniqueChars: string[];
    };
    seedSets: RuntimeCharSet[];
    xtraPattern: RuntimeCharSet | undefined;
    mainSet: string[];
    charSet: string[];
    charSetUnique: string[];
    passiveInitialAnimationChars: string[];
};

type RuntimeCharSet = {
    source: string;
    chars: string[];
    uniqueChars: string[];
    integers: CharInteger[];
};

type CharInteger = {
    char: string;
    decimal: number;
    hex: string;
};

type ScriptConstants = {
    MODE: number | undefined;
    LEVEL: number | undefined;
    BIOMECODE: string[];
    BIOME: number | undefined;
    ZONE: string | undefined;
    CHROMA: string | undefined;
    ANTENNA: number | undefined;
    ATTUNEMENT: number | undefined;
    RESOURCE: number | undefined;
    DIRECTION: number | undefined;
    SEED: number | undefined;
    TIME: number | undefined;
};

type ModeFlags = {
    isTerrain: boolean;
    isDaydream: boolean;
    isTerraformed: boolean;
    isOrigin: boolean;
    isPlague: boolean;
    isXSeed: boolean;
    isYSeed: boolean;
    overdrive: boolean;
};

type ExtractedArtifacts = {
    inputPath: string;
    outputDir: string;
    html: string;
    styles: string[];
    scriptsRaw: string[];
    scriptsDecoded: string[];
    cells: Cell[];
    fonts: FontArtifact[];
};

const FLAGS: FlagSpec[] = [
    { name: "output-dir", short: "o", value: true },
    { name: "help", short: "h" },
];

const HELP = `Usage: yarn dissect:html <htmlPath> [options]

Split a generated Terraforms HTML/SVG artwork into persisted artifacts and produce
a runtime animation/font/charset report.

Options:
  -o, --output-dir <dir>  Artifact directory (default tmp/<input-basename>-dissect)
  -h, --help              Show this help
`;

const COUNT_PATTERN_SETS = [
    [16, 16, 16, 2, 2, 2, 2, 4, 4, 4, 4],
    [16, 32, 8, 16, 2, 2, 2, 2, 4, 4, 4, 4],
    [2, 4, 2, 4, 2, 24, 8, 8, 8, 8, 4, 4, 2],
    [2, 2, 2, 2, 2, 8, 8, 8, 8, 4, 4, 4],
    [12, 4, 2, 8, 8, 4, 4, 4, 8, 4, 4, 4],
    [24, 4, 4, 2],
    [8, 4, 4, 2],
    [2, 8, 2, 2, 8, 2, 2, 2, 8, 4, 4, 4],
    [5, 5, 5, 5],
    [7, 7, 7, 7],
];

async function main() {
    const parsed = parseArgs(process.argv.slice(2), FLAGS);
    if (getBooleanOption(parsed, "help")) {
        console.log(HELP);
        return;
    }

    const inputPath = requireSinglePositional(parsed, "htmlPath");
    const outputDir =
        getStringOption(parsed, "output-dir") ?? defaultOutputDir(inputPath);

    const artifacts = await extractArtifacts(inputPath, outputDir);
    const analysis = analyzeArtifacts(artifacts);

    await writeJson(
        path.join(outputDir, "runtime-charsets.json"),
        serializeRuntimeAnalysis(analysis),
    );
    await writeFile(
        path.join(outputDir, "uni-fromcharcode-map.tsv"),
        renderUniMapTsv(analysis.uni),
        "utf8",
    );
    await writeFile(
        path.join(outputDir, "font-coverage.tsv"),
        renderFontCoverageTsv(analysis, artifacts.fonts),
        "utf8",
    );
    await writeFile(
        path.join(outputDir, "report.md"),
        renderReport(artifacts, analysis),
        "utf8",
    );

    console.log(`Artifacts written to: ${outputDir}`);
    console.log(`Report: ${path.join(outputDir, "report.md")}`);
}

async function extractArtifacts(
    inputPath: string,
    outputDir: string,
): Promise<ExtractedArtifacts> {
    const html = await readFile(inputPath, "utf8");
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, "source.html"), html, "utf8");

    const styles = collectTagContents(html, "style");
    const scriptsRaw = collectTagContents(html, "script");
    const scriptsDecoded = scriptsRaw.map(decodeHtmlEntities);

    await Promise.all(
        styles.flatMap((style, index) => [
            writeFile(path.join(outputDir, `style-${index}.css`), style, "utf8"),
            writeFile(
                path.join(outputDir, `style-${index}.no-font.css`),
                stripFontPayloads(style),
                "utf8",
            ),
        ]),
    );

    await Promise.all(
        scriptsRaw.flatMap((script, index) => [
            writeFile(
                path.join(outputDir, `script-${index}.raw-entities.js`),
                script,
                "utf8",
            ),
            writeFile(
                path.join(outputDir, `script-${index}.decoded.js`),
                scriptsDecoded[index] ?? "",
                "utf8",
            ),
            writeFile(
                path.join(outputDir, `script-${index}.decoded.readable-no-font.js`),
                formatJavaScriptLite(
                    stripFontPayloads(scriptsDecoded[index] ?? ""),
                ),
                "utf8",
            ),
        ]),
    );

    const cells = parseCells(html);
    await writeFile(
        path.join(outputDir, "grid.initial.chars.txt"),
        renderGrid(cells.map((cell) => cell.text)),
        "utf8",
    );
    await writeFile(
        path.join(outputDir, "grid.initial.classes.txt"),
        renderGrid(cells.map((cell) => cell.className)),
        "utf8",
    );

    const fonts = await extractFonts(styles, scriptsDecoded, outputDir);
    await writeJson(path.join(outputDir, "summary.json"), {
        source: inputPath,
        bytes: Buffer.byteLength(html, "utf8"),
        styleBlocks: styles.length,
        scriptBlocks: scriptsRaw.length,
        pCells: cells.length,
        fontPayloads: fonts.map((font) => ({
            source: font.source,
            family: font.family,
            file: font.fileName,
            format: font.format,
            base64Len: font.base64Length,
            bytes: font.byteLength,
            cmapCount: font.codepoints?.size,
        })),
        entityCountsInScripts: {
            "&lt;": countOccurrences(scriptsRaw.join("\n"), "&lt;"),
            "&gt;": countOccurrences(scriptsRaw.join("\n"), "&gt;"),
            "&amp;": countOccurrences(scriptsRaw.join("\n"), "&amp;"),
        },
    });

    return {
        inputPath,
        outputDir,
        html,
        styles,
        scriptsRaw,
        scriptsDecoded,
        cells,
        fonts,
    };
}

function analyzeArtifacts(artifacts: ExtractedArtifacts): RuntimeAnalysis {
    const script = artifacts.scriptsDecoded.join("\n");
    const constants = extractScriptConstants(script);
    const mode = constants.MODE ?? 0;
    const seed = constants.SEED ?? 0;
    const biome = constants.BIOME ?? 0;
    const antenna = constants.ANTENNA ?? 0;
    const chroma = constants.CHROMA ?? "";
    const isDaydream = mode === 1 || mode === 3;
    const isTerraformed = mode === 2 || mode === 4;
    const isOrigin = mode === 3 || mode === 4;
    const isXSeed = isOrigin ? seed > 9000 : seed > 9970;
    const isYSeed = seed > 9950 && seed <= 9970;
    const flags: ModeFlags = {
        isTerrain: mode === 0,
        isDaydream,
        isTerraformed,
        isOrigin,
        isPlague: chroma === "Plague",
        isXSeed,
        isYSeed,
        overdrive: seed > 9950,
    };

    const classIds = extractStringArray(script, "classIds");
    const effectiveClassIds =
        classIds.length > 0
            ? classIds
            : ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const initialGrid = analyzeInitialGrid(artifacts.cells, effectiveClassIds);
    const fontStack = extractFontStack(artifacts.styles, script);
    const uni = extractNumberArray(script, "uni");
    const biomeCore = constants.BIOMECODE;
    let biomeCoreAfterAntenna = [...biomeCore];

    if (biome === 0 && mode > 0 && antenna === 1) {
        biomeCoreAfterAntenna.push(" ", " ", " ", " ", " ");
    }
    if (antenna === 0 && mode > 0) {
        biomeCoreAfterAntenna = orderedUnique(biomeCoreAfterAntenna);
    }

    const coreCharsetLength = biomeCoreAfterAntenna.length;
    const seedSets: RuntimeCharSet[] = [];
    const bladeRailSequencer = extractStringArray(script, "bladeRailSequencer");
    const bladeIndex =
        bladeRailSequencer.length > 0
            ? positiveModulo(biome + seed, bladeRailSequencer.length)
            : undefined;
    const patternBlade =
        bladeIndex === undefined
            ? []
            : Array.from(bladeRailSequencer[bladeIndex] ?? "").map((char) =>
                  char === "▰" ? "░" : char,
              );
    const bladeEngaged = !isOrigin && !isXSeed && !isYSeed;

    let selectedUniIndex: number | undefined;
    let selectedUniValue: number | undefined;
    let selectedUniReason = "not selected";

    if (isOrigin) {
        if (isXSeed) {
            for (const value of uni) {
                seedSets.push(toRuntimeCharSet(`uni ${value}`, makeSet(value)));
            }
            selectedUniReason = "origin X-seed uses every uni range";
        } else {
            selectedUniIndex = positiveModulo(Math.floor(seed), uni.length);
            selectedUniValue = uni[selectedUniIndex];
            if (selectedUniValue !== undefined) {
                seedSets.push(
                    toRuntimeCharSet(
                        `uni[${selectedUniIndex}] ${selectedUniValue}`,
                        makeSet(selectedUniValue),
                    ),
                );
            }
            selectedUniReason =
                "origin non-X seed uses uni[Math.floor(SEED) % uni.length]";
        }
    } else if (isXSeed) {
        for (const value of uni) {
            seedSets.push(toRuntimeCharSet(`uni ${value}`, makeSet(value)));
        }
        selectedUniReason = "non-origin X-seed uses every uni range";
    } else if (isYSeed) {
        selectedUniIndex = positiveModulo(Math.floor(seed), 3);
        selectedUniValue = uni[selectedUniIndex];
        if (selectedUniValue !== undefined) {
            seedSets.push(
                toRuntimeCharSet(
                    `reversed uni[${selectedUniIndex}] ${selectedUniValue}`,
                    makeSet(selectedUniValue).reverse(),
                ),
            );
        }
        selectedUniReason = "Y-seed uses reversed uni[Math.floor(SEED) % 3]";
    } else {
        seedSets.push(toRuntimeCharSet("blade pattern", patternBlade));
        selectedUniReason = "non-origin non-X/non-Y seed uses blade pattern";
    }

    let xtraPattern: RuntimeCharSet | undefined;
    if (isOrigin && !isXSeed && (isDaydream || isTerraformed)) {
        const countPattern = COUNT_PATTERN_SETS[positiveModulo(seed, COUNT_PATTERN_SETS.length)] ?? [];
        const chars: string[] = [];
        let i = 0;
        for (const count of countPattern) {
            for (let j = 0; j < count; j += 1) {
                const set = seedSets[positiveModulo(seed, seedSets.length)]?.chars ?? [];
                const char = set[positiveModulo(seed + i, set.length)];
                if (char !== undefined) chars.push(char);
            }
            i += 1;
        }
        xtraPattern = toRuntimeCharSet(
            `origin xtraPattern from countPattern [${countPattern.join(",")}]`,
            chars,
        );
        seedSets.push(xtraPattern);
    }

    const charSet = [...biomeCoreAfterAntenna, ...seedSets.flatMap((set) => set.chars)];
    const mainSet = [...biomeCoreAfterAntenna].reverse();
    const effectiveMainSet = flags.overdrive ? charSet : mainSet;
    const passiveInitialAnimationChars = initialGrid.allCellsHeightZero
        ? orderedUnique(effectiveMainSet)
        : [];

    return {
        constants,
        flags,
        classIds: effectiveClassIds,
        initialGrid,
        fontStack,
        biomeCore,
        biomeCoreAfterAntenna,
        coreCharsetLength,
        uni,
        selectedUni: {
            index: selectedUniIndex,
            value: selectedUniValue,
            reason: selectedUniReason,
        },
        blade: {
            computed: patternBlade.length > 0,
            engaged: bladeEngaged,
            index: bladeIndex,
            uniqueChars: orderedUnique(patternBlade),
        },
        seedSets,
        xtraPattern,
        mainSet: effectiveMainSet,
        charSet,
        charSetUnique: orderedUnique(charSet),
        passiveInitialAnimationChars,
    };
}

function renderReport(
    artifacts: ExtractedArtifacts,
    analysis: RuntimeAnalysis,
): string {
    const c = analysis.constants;
    const selectedSet = analysis.selectedUni.value
        ? makeSet(analysis.selectedUni.value)
        : undefined;
    const sections = [
        "# Token HTML Dissection",
        "",
        `Source: \`${artifacts.inputPath}\``,
        "",
        "## Extracted Structure",
        "",
        `- Size: ${Buffer.byteLength(artifacts.html, "utf8").toLocaleString()} bytes.`,
        `- Style blocks: ${artifacts.styles.length}.`,
        `- Script blocks: ${artifacts.scriptsRaw.length}.`,
        `- Grid cells: ${artifacts.cells.length} \`<p>\` elements.`,
        `- Embedded font payloads: ${artifacts.fonts.length}.`,
        `- Script entity counts: \`&lt;\` ${countOccurrences(artifacts.scriptsRaw.join("\n"), "&lt;")}, \`&gt;\` ${countOccurrences(artifacts.scriptsRaw.join("\n"), "&gt;")}, \`&amp;\` ${countOccurrences(artifacts.scriptsRaw.join("\n"), "&amp;")}.`,
        "",
        "## Runtime Constants",
        "",
        "```js",
        `let MODE = ${formatValue(c.MODE)};`,
        `let LEVEL = ${formatValue(c.LEVEL)};`,
        `let BIOMECODE = [${c.BIOMECODE.map((char) => quoteJs(char)).join(", ")}];`,
        `let BIOME = ${formatValue(c.BIOME)};`,
        `let ZONE = ${quoteJs(c.ZONE ?? "")};`,
        `let CHROMA = ${quoteJs(c.CHROMA ?? "")};`,
        `let ANTENNA = ${formatValue(c.ANTENNA)};`,
        `let ATTUNEMENT = ${formatValue(c.ATTUNEMENT)};`,
        `let RESOURCE = ${formatValue(c.RESOURCE)};`,
        `let DIRECTION = ${formatValue(c.DIRECTION)};`,
        `const SEED = ${formatValue(c.SEED)};`,
        `let TIME = ${formatValue(c.TIME)};`,
        "```",
        "",
        "Mode flags:",
        "",
        `- Terrain: ${analysis.flags.isTerrain}.`,
        `- Daydream: ${analysis.flags.isDaydream}.`,
        `- Terraformed: ${analysis.flags.isTerraformed}.`,
        `- Origin: ${analysis.flags.isOrigin}.`,
        `- X-seed: ${analysis.flags.isXSeed}.`,
        `- Y-seed: ${analysis.flags.isYSeed}.`,
        `- Overdrive: ${analysis.flags.overdrive}.`,
        "",
        "## Initial Grid",
        "",
        `- Unique initial chars: ${formatCharList(analysis.initialGrid.uniqueChars)}.`,
        `- Unique initial classes: ${analysis.initialGrid.uniqueClasses.join(", ") || "(none)"}.`,
        `- Height counts from classes: ${formatHeightCounts(analysis.initialGrid.heightCounts)}.`,
        `- All cells start at height 0: ${analysis.initialGrid.allCellsHeightZero}.`,
        "",
        "## Charset Selection",
        "",
        "`makeSet()` uses `String.fromCharCode()`. Values above `0xFFFF` are therefore truncated to a 16-bit code unit before rendering.",
        "",
        "```js",
        "let uni = [",
        ...analysis.uni.map((value) => `  ${formatUniLine(value)}`),
        "];",
        "```",
        "",
        `Selected charset path: ${analysis.selectedUni.reason}.`,
        selectedSet && analysis.selectedUni.index !== undefined
            ? `Selected \`uni[${analysis.selectedUni.index}]\` value: ${analysis.selectedUni.value}.`
            : undefined,
        selectedSet ? "" : undefined,
        selectedSet ? "Selected `makeSet()` characters:" : undefined,
        selectedSet ? "" : undefined,
        selectedSet ? "```text" : undefined,
        selectedSet ? selectedSet.join("") : undefined,
        selectedSet ? "```" : undefined,
        selectedSet ? "" : undefined,
        selectedSet ? "Integer representation for selected `makeSet()` characters:" : undefined,
        selectedSet ? "" : undefined,
        selectedSet ? "```js" : undefined,
        selectedSet ? "[" : undefined,
        ...(selectedSet
            ? selectedSet.map(
                  (char) =>
                      `  ${char.codePointAt(0) ?? 0}, // ${char} ${toHex(char.codePointAt(0) ?? 0)}`,
              )
            : []),
        selectedSet ? "]" : undefined,
        selectedSet ? "```" : undefined,
        "",
        `Biome core before antenna logic: ${formatCharList(analysis.biomeCore)}.`,
        `Biome core after antenna logic: ${formatCharList(analysis.biomeCoreAfterAntenna)}.`,
        `Main set used for height-0 cells: ${formatCharList(analysis.mainSet)}.`,
        `Full runtime charSet unique chars: ${formatCharList(analysis.charSetUnique)}.`,
        "",
        "Seed sets:",
        "",
        ...analysis.seedSets.flatMap((set) => [
            `- ${set.source}: ${formatCharList(set.uniqueChars)}.`,
        ]),
        "",
        `Blade pattern computed: ${analysis.blade.computed}.`,
        `Blade pattern engaged in seedSet: ${analysis.blade.engaged}.`,
        analysis.blade.index !== undefined
            ? `Blade pattern index: ${analysis.blade.index}.`
            : undefined,
        analysis.xtraPattern
            ? `Origin xtraPattern enabled: ${formatCharList(analysis.xtraPattern.uniqueChars)}.`
            : "Origin xtraPattern enabled: false.",
        "",
        "## Embedded Font Coverage",
        "",
        `Effective \`p\` font stack: ${analysis.fontStack.join(", ") || "(not detected)"}.`,
        "",
        ...artifacts.fonts.flatMap((font) => [
            `- ${font.fileName}: family ${font.family ?? "(unknown)"}, format ${font.format}, cmap entries ${font.codepoints?.size ?? "unavailable"}.`,
        ]),
        "",
        "Coverage for passive initial animation chars:",
        "",
        renderCoverageTable(
            analysis.passiveInitialAnimationChars.length > 0
                ? analysis.passiveInitialAnimationChars
                : analysis.mainSet,
            analysis,
            artifacts.fonts,
        ),
        "",
        "Coverage for full runtime charSet unique chars:",
        "",
        renderCoverageTable(analysis.charSetUnique, analysis, artifacts.fonts),
        "",
        "## Runtime Animation Explanation",
        "",
        renderAnimationExplanation(analysis),
        "",
        "## Persisted Artifacts",
        "",
        "- `source.html`: original input HTML.",
        "- `style-*.css`: extracted CSS blocks.",
        "- `style-*.no-font.css`: extracted CSS with embedded font payloads replaced by comments.",
        "- `script-*.raw-entities.js`: script blocks exactly as embedded.",
        "- `script-*.decoded.js`: HTML-entity-decoded script blocks.",
        "- `script-*.decoded.readable-no-font.js`: decoded script with embedded font payloads omitted and light formatting applied.",
        "- `font-*-html.*`: extracted embedded font payloads.",
        "- `grid.initial.chars.txt`: 32x32 initial character grid.",
        "- `grid.initial.classes.txt`: 32x32 initial class grid.",
        "- `summary.json`: extraction summary.",
        "- `runtime-charsets.json`: structured runtime charset derivation.",
        "- `uni-fromcharcode-map.tsv`: `uni` values mapped through actual `fromCharCode()` behavior.",
        "- `font-coverage.tsv`: character to embedded-font/fallback mapping.",
        "",
    ];

    return sections.filter((line) => line !== undefined).join("\n");
}

function renderAnimationExplanation(analysis: RuntimeAnalysis): string {
    if (analysis.flags.isTerrain) {
        const resource = analysis.constants.RESOURCE;
        const scaledResource =
            typeof resource === "number" ? resource / 10000 : undefined;
        const threshold =
            scaledResource === undefined ? undefined : 6 - scaledResource;
        return [
            "The terrain branch is active because `MODE == 0`.",
            threshold === undefined
                ? "- The terrain height threshold could not be derived because `RESOURCE` was not parsed."
                : `- The script scales \`RESOURCE\` by \`1e4\`; effective resource is ${scaledResource?.toFixed(4)}, so cells animate when \`h > ${threshold.toFixed(4)}\`.`,
            "- Animated terrain cells select from `mainSet` using `airship`, height, column, direction, and row.",
        ].join("\n");
    }

    if (analysis.flags.isDaydream || analysis.flags.isTerraformed) {
        return [
            "The Daydream/Terraformed branch is active.",
            analysis.constants.ANTENNA && analysis.constants.ANTENNA > 0
                ? "- `ANTENNA > 0`, so each cell derives `m1` from distance-based antenna motion."
                : "- `ANTENNA == 0`, so all cells derive `m1` from `Math.floor(airship * drive % charSet.length)`.",
            "- Cells with `h == 0` render from `mainSet`.",
            "- Cells with `h > 0` render from the full `charSet` using `brushSpeeds[brushSpeedIndex]` and height.",
            analysis.initialGrid.allCellsHeightZero
                ? `- In the persisted initial grid every cell has height 0, so passive playback starts by cycling only through ${formatCharList(analysis.mainSet)}.`
                : "- The persisted initial grid includes nonzero heights, so passive playback can exercise the broader `charSet` immediately.",
            analysis.blade.engaged
                ? "- The blade rail sequencer is engaged for this token and contributes to `seedSet`."
                : "- The blade rail sequencer is not engaged for this token's active `seedSet` path.",
        ].join("\n");
    }

    return "No known Terraforms animation branch was derived for this MODE.";
}

function renderCoverageTable(
    chars: string[],
    analysis: RuntimeAnalysis,
    fonts: FontArtifact[],
): string {
    const rows = [
        "| Char | Decimal | Unicode | Embedded font |",
        "| --- | ---: | --- | --- |",
    ];
    for (const char of orderedUnique(chars)) {
        const codepoint = char.codePointAt(0);
        if (codepoint === undefined) continue;
        rows.push(
            `| ${escapeMarkdownCell(displayChar(char))} | ${codepoint} | ${toHex(codepoint)} | ${escapeMarkdownCell(resolveEmbeddedFont(char, analysis.fontStack, fonts))} |`,
        );
    }
    return rows.join("\n");
}

function renderUniMapTsv(uni: number[]): string {
    const lines = [
        [
            "input_decimal",
            "input_hex_if_codepoint",
            "actual_start_decimal",
            "actual_start_hex",
            "actual_start_char",
            "actual_fromCharCode_range",
        ].join("\t"),
    ];
    for (const value of uni) {
        const range = makeSet(value);
        const first = range[0] ?? "";
        const firstCodepoint = first.codePointAt(0) ?? 0;
        lines.push(
            [
                String(value),
                toHex(value),
                String(firstCodepoint),
                toHex(firstCodepoint),
                first,
                range.join(""),
            ].join("\t"),
        );
    }
    return `${lines.join("\n")}\n`;
}

function renderFontCoverageTsv(
    analysis: RuntimeAnalysis,
    fonts: FontArtifact[],
): string {
    const chars = orderedUnique([
        ...analysis.mainSet,
        ...analysis.charSetUnique,
        ...analysis.initialGrid.uniqueChars,
    ]);
    const lines = [["char", "decimal", "unicode", "embedded_font"].join("\t")];
    for (const char of chars) {
        const codepoint = char.codePointAt(0);
        if (codepoint === undefined) continue;
        lines.push(
            [
                char,
                String(codepoint),
                toHex(codepoint),
                resolveEmbeddedFont(char, analysis.fontStack, fonts),
            ].join("\t"),
        );
    }
    return `${lines.join("\n")}\n`;
}

function serializeRuntimeAnalysis(analysis: RuntimeAnalysis) {
    return {
        ...analysis,
        seedSets: analysis.seedSets.map(serializeRuntimeCharSet),
        xtraPattern: analysis.xtraPattern
            ? serializeRuntimeCharSet(analysis.xtraPattern)
            : undefined,
    };
}

function serializeRuntimeCharSet(set: RuntimeCharSet) {
    return {
        source: set.source,
        chars: set.chars,
        uniqueChars: set.uniqueChars,
        integers: set.integers,
    };
}

async function extractFonts(
    styles: string[],
    scriptsDecoded: string[],
    outputDir: string,
): Promise<FontArtifact[]> {
    const inputs = [
        ...styles.map((content, index) => ({
            source: `style-${index}`,
            content,
        })),
        ...scriptsDecoded.map((content, index) => ({
            source: `script-${index}`,
            content,
        })),
    ];
    const fonts: FontArtifact[] = [];
    const seen = new Set<string>();

    for (const input of inputs) {
        for (const found of findFontPayloads(input.content)) {
            const normalizedBase64 = found.base64.replace(/\s+/g, "");
            if (seen.has(normalizedBase64)) continue;
            seen.add(normalizedBase64);

            const buffer = Buffer.from(normalizedBase64, "base64");
            const format = sniffFontFormat(buffer);
            const index = fonts.length;
            const fileName = `font-${index}-html.${format}`;
            await writeFile(path.join(outputDir, fileName), buffer);
            fonts.push({
                index,
                source: input.source,
                family: found.family,
                fileName,
                format,
                base64Length: normalizedBase64.length,
                byteLength: buffer.length,
                codepoints: parseFontCodepoints(buffer),
            });
        }
    }

    return fonts;
}

function findFontPayloads(content: string): Array<{
    family: string | undefined;
    base64: string;
}> {
    const results: Array<{ family: string | undefined; base64: string }> = [];
    const fontFaceRegex = /@font-face\s*\{[\s\S]*?\}/gi;
    let match: RegExpExecArray | null;
    while ((match = fontFaceRegex.exec(content))) {
        const block = match[0];
        const family = block.match(
            /font-family\s*:\s*(?:"([^"]+)"|'([^']+)'|([^;}\s]+))/i,
        );
        const payload = block.match(/base64,([A-Za-z0-9+/=\s]+)/i);
        if (!payload?.[1]) continue;
        results.push({
            family: family?.[1] ?? family?.[2] ?? family?.[3],
            base64: payload[1],
        });
    }
    return results;
}

function parseFontCodepoints(buffer: Buffer): Set<number> | undefined {
    const signature = buffer.subarray(0, 4).toString("ascii");
    if (signature === "wOFF" || signature === "wOF2") return undefined;
    if (buffer.length < 12) return undefined;

    const numTables = readU16(buffer, 4);
    let cmapOffset: number | undefined;
    let cmapLength: number | undefined;

    for (let i = 0; i < numTables; i += 1) {
        const offset = 12 + i * 16;
        if (offset + 16 > buffer.length) break;
        const tag = buffer.subarray(offset, offset + 4).toString("ascii");
        if (tag !== "cmap") continue;
        cmapOffset = readU32(buffer, offset + 8);
        cmapLength = readU32(buffer, offset + 12);
        break;
    }

    if (
        cmapOffset === undefined ||
        cmapLength === undefined ||
        cmapOffset + cmapLength > buffer.length
    ) {
        return undefined;
    }

    return parseCmapTable(buffer.subarray(cmapOffset, cmapOffset + cmapLength));
}

function parseCmapTable(cmap: Buffer): Set<number> {
    const codepoints = new Set<number>();
    if (cmap.length < 4) return codepoints;
    const numTables = readU16(cmap, 2);

    for (let i = 0; i < numTables; i += 1) {
        const recordOffset = 4 + i * 8;
        if (recordOffset + 8 > cmap.length) break;
        const subtableOffset = readU32(cmap, recordOffset + 4);
        if (subtableOffset >= cmap.length || subtableOffset + 2 > cmap.length) {
            continue;
        }
        const format = readU16(cmap, subtableOffset);
        if (format === 0) {
            parseCmapFormat0(cmap, subtableOffset, codepoints);
        } else if (format === 4) {
            parseCmapFormat4(cmap, subtableOffset, codepoints);
        } else if (format === 6) {
            parseCmapFormat6(cmap, subtableOffset, codepoints);
        } else if (format === 12) {
            parseCmapFormat12(cmap, subtableOffset, codepoints);
        }
    }

    return codepoints;
}

function parseCmapFormat0(cmap: Buffer, offset: number, out: Set<number>) {
    if (offset + 262 > cmap.length) return;
    for (let i = 0; i < 256; i += 1) {
        if (cmap[offset + 6 + i] !== 0) out.add(i);
    }
}

function parseCmapFormat4(cmap: Buffer, offset: number, out: Set<number>) {
    if (offset + 16 > cmap.length) return;
    const length = readU16(cmap, offset + 2);
    const end = Math.min(offset + length, cmap.length);
    const segCount = readU16(cmap, offset + 6) / 2;
    const endCodeOffset = offset + 14;
    const startCodeOffset = endCodeOffset + segCount * 2 + 2;
    const idDeltaOffset = startCodeOffset + segCount * 2;
    const idRangeOffsetOffset = idDeltaOffset + segCount * 2;

    for (let i = 0; i < segCount; i += 1) {
        const endCode = readU16(cmap, endCodeOffset + i * 2);
        const startCode = readU16(cmap, startCodeOffset + i * 2);
        const idDelta = readI16(cmap, idDeltaOffset + i * 2);
        const idRangeOffsetAddress = idRangeOffsetOffset + i * 2;
        const idRangeOffset = readU16(cmap, idRangeOffsetAddress);
        if (startCode === 0xffff && endCode === 0xffff) continue;

        for (let cp = startCode; cp <= endCode; cp += 1) {
            let glyphId: number;
            if (idRangeOffset === 0) {
                glyphId = (cp + idDelta) & 0xffff;
            } else {
                const glyphOffset =
                    idRangeOffsetAddress +
                    idRangeOffset +
                    (cp - startCode) * 2;
                if (glyphOffset + 2 > end) continue;
                const glyphIndex = readU16(cmap, glyphOffset);
                glyphId =
                    glyphIndex === 0 ? 0 : (glyphIndex + idDelta) & 0xffff;
            }
            if (glyphId !== 0) out.add(cp);
        }
    }
}

function parseCmapFormat6(cmap: Buffer, offset: number, out: Set<number>) {
    if (offset + 10 > cmap.length) return;
    const firstCode = readU16(cmap, offset + 6);
    const entryCount = readU16(cmap, offset + 8);
    for (let i = 0; i < entryCount; i += 1) {
        const glyphOffset = offset + 10 + i * 2;
        if (glyphOffset + 2 > cmap.length) break;
        if (readU16(cmap, glyphOffset) !== 0) out.add(firstCode + i);
    }
}

function parseCmapFormat12(cmap: Buffer, offset: number, out: Set<number>) {
    if (offset + 16 > cmap.length) return;
    const nGroups = readU32(cmap, offset + 12);
    for (let i = 0; i < nGroups; i += 1) {
        const groupOffset = offset + 16 + i * 12;
        if (groupOffset + 12 > cmap.length) break;
        const startCharCode = readU32(cmap, groupOffset);
        const endCharCode = readU32(cmap, groupOffset + 4);
        for (let cp = startCharCode; cp <= endCharCode; cp += 1) {
            out.add(cp);
        }
    }
}

function extractScriptConstants(script: string): ScriptConstants {
    return {
        MODE: extractNumberConstant(script, "MODE"),
        LEVEL: extractNumberConstant(script, "LEVEL"),
        BIOMECODE: extractStringArray(script, "BIOMECODE"),
        BIOME: extractNumberConstant(script, "BIOME"),
        ZONE: extractStringConstant(script, "ZONE"),
        CHROMA: extractStringConstant(script, "CHROMA"),
        ANTENNA: extractNumberConstant(script, "ANTENNA"),
        ATTUNEMENT: extractNumberConstant(script, "ATTUNEMENT"),
        RESOURCE: extractNumberConstant(script, "RESOURCE"),
        DIRECTION: extractNumberConstant(script, "DIRECTION"),
        SEED: extractNumberConstant(script, "SEED"),
        TIME: extractNumberConstant(script, "TIME"),
    };
}

function extractNumberConstant(
    script: string,
    name: string,
): number | undefined {
    const match = script.match(
        new RegExp(`(?:let|const|var)\\s+${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`),
    );
    if (!match?.[1]) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
}

function extractStringConstant(
    script: string,
    name: string,
): string | undefined {
    const match = script.match(
        new RegExp(
            `(?:let|const|var)\\s+${name}\\s*=\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`,
        ),
    );
    if (!match?.[2]) return undefined;
    return decodeJsString(match[2]);
}

function extractNumberArray(script: string, name: string): number[] {
    const literal = extractArrayLiteral(script, name);
    if (!literal) return [];
    return Array.from(literal.matchAll(/-?\d+/g)).map((match) =>
        Number(match[0]),
    );
}

function extractStringArray(script: string, name: string): string[] {
    const literal = extractArrayLiteral(script, name);
    if (!literal) return [];
    const values: string[] = [];
    let quote: string | undefined;
    let buffer = "";
    let escaping = false;

    for (let i = 0; i < literal.length; i += 1) {
        const char = literal[i];
        if (!quote) {
            if (char === "'" || char === '"' || char === "`") {
                quote = char;
                buffer = "";
                escaping = false;
            }
            continue;
        }

        if (escaping) {
            buffer += decodeJsEscape(char);
            escaping = false;
            continue;
        }
        if (char === "\\") {
            escaping = true;
            continue;
        }
        if (char === quote) {
            values.push(buffer);
            quote = undefined;
            buffer = "";
            continue;
        }
        buffer += char;
    }

    return values;
}

function extractArrayLiteral(script: string, name: string): string | undefined {
    const assignment = script.search(
        new RegExp(`(?:let|const|var)\\s+${name}\\s*=`),
    );
    if (assignment === -1) return undefined;
    const start = script.indexOf("[", assignment);
    if (start === -1) return undefined;

    let depth = 0;
    let quote: string | undefined;
    let escaping = false;
    for (let i = start; i < script.length; i += 1) {
        const char = script[i];
        if (quote) {
            if (escaping) {
                escaping = false;
            } else if (char === "\\") {
                escaping = true;
            } else if (char === quote) {
                quote = undefined;
            }
            continue;
        }
        if (char === "'" || char === '"' || char === "`") {
            quote = char;
            continue;
        }
        if (char === "[") depth += 1;
        if (char === "]") {
            depth -= 1;
            if (depth === 0) return script.slice(start, i + 1);
        }
    }
    return undefined;
}

function extractFontStack(styles: string[], script: string): string[] {
    const stacks: string[] = [];
    for (const style of styles) {
        for (const match of style.matchAll(/p\s*\{[^}]*font-family\s*:\s*([^;}]+)/gi)) {
            if (match[1]) stacks.push(match[1]);
        }
    }
    for (const match of script.matchAll(
        /cssMod\(\s*["']p["']\s*,\s*["']font-family\s*:\s*([^"']+)["']\s*\)/gi,
    )) {
        if (match[1]) stacks.push(match[1]);
    }
    const effective = stacks.at(-1);
    return effective ? splitFontStack(effective) : [];
}

function splitFontStack(value: string): string[] {
    return value
        .split(",")
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
}

function analyzeInitialGrid(cells: Cell[], classIds: string[]) {
    const heightCounts: Record<string, number> = {};
    const uniqueChars = orderedUnique(cells.map((cell) => cell.text));
    const uniqueClasses = orderedUnique(cells.map((cell) => cell.className));

    for (const cell of cells) {
        const height = classIds.indexOf(cell.className);
        const key = height === -1 ? "unknown" : String(height);
        heightCounts[key] = (heightCounts[key] ?? 0) + 1;
    }

    return {
        cells: cells.length,
        heightCounts,
        uniqueChars,
        uniqueClasses,
        allCellsHeightZero:
            cells.length > 0 &&
            cells.every((cell) => classIds.indexOf(cell.className) === 0),
    };
}

function toRuntimeCharSet(source: string, chars: string[]): RuntimeCharSet {
    return {
        source,
        chars,
        uniqueChars: orderedUnique(chars),
        integers: orderedUnique(chars).map(toCharInteger),
    };
}

function toCharInteger(char: string): CharInteger {
    const decimal = char.codePointAt(0) ?? 0;
    return { char, decimal, hex: toHex(decimal) };
}

function makeSet(startRange: number): string[] {
    const chars: string[] = [];
    for (let i = startRange; i < startRange + 10; i += 1) {
        chars.push(String.fromCharCode(i));
    }
    return chars;
}

function formatUniLine(value: number): string {
    const first = String.fromCharCode(value);
    const decimal = first.codePointAt(0) ?? 0;
    const rangeEnd = (decimal + 9) & 0xffff;
    const inputNote =
        value === decimal
            ? `decimal ${decimal}, ${toHex(decimal)}`
            : `actual decimal ${decimal}, ${toHex(decimal)} after fromCharCode truncation; input-as-codepoint ${toHex(value)}`;
    return `${value}, // ${first}; ${inputNote}; makeSet range ${toHex(decimal)}..${toHex(rangeEnd)}`;
}

function resolveEmbeddedFont(
    char: string,
    fontStack: string[],
    fonts: FontArtifact[],
): string {
    const codepoint = char.codePointAt(0);
    if (codepoint === undefined) return "unknown";
    const byFamily = new Map(
        fonts
            .filter((font) => font.family)
            .map((font) => [font.family as string, font]),
    );
    for (const family of fontStack) {
        const font = byFamily.get(family);
        if (!font) {
            if (isGenericFontFamily(family)) return "fallback/system";
            continue;
        }
        if (font.codepoints?.has(codepoint)) return family;
    }
    return "fallback/system";
}

function isGenericFontFamily(family: string): boolean {
    return ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"].includes(
        family.toLowerCase(),
    );
}

function collectTagContents(html: string, tag: string): string[] {
    const blocks: string[] = [];
    const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html))) {
        blocks.push(match[1] ?? "");
    }
    return blocks;
}

function parseCells(html: string): Cell[] {
    const cells: Cell[] = [];
    const regex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html))) {
        const attrs = match[1] ?? "";
        const inner = match[2] ?? "";
        const classMatch = attrs.match(
            /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
        );
        cells.push({
            className:
                classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? "",
            text: decodeHtmlEntities(inner.replace(/<[^>]*>/g, "")),
        });
    }
    return cells;
}

function decodeHtmlEntities(input: string): string {
    return input.replace(
        /&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi,
        (entity, body: string) => {
            const normalized = body.toLowerCase();
            if (normalized === "lt") return "<";
            if (normalized === "gt") return ">";
            if (normalized === "amp") return "&";
            if (normalized === "quot") return '"';
            if (normalized === "apos") return "'";
            if (normalized.startsWith("#x")) {
                return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
            }
            if (normalized.startsWith("#")) {
                return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
            }
            return entity;
        },
    );
}

function decodeJsString(input: string): string {
    return input.replace(/\\(.)/g, (_, escaped: string) => decodeJsEscape(escaped));
}

function decodeJsEscape(char: string): string {
    if (char === "n") return "\n";
    if (char === "r") return "\r";
    if (char === "t") return "\t";
    return char;
}

function stripFontPayloads(input: string): string {
    return input.replace(
        /base64,[A-Za-z0-9+/=\s]+/g,
        "base64,/* embedded font payload omitted; see extracted font files */",
    );
}

function formatJavaScriptLite(input: string): string {
    let result = "";
    let quote: string | undefined;
    let escaping = false;
    for (const char of input) {
        result += char;
        if (quote) {
            if (escaping) {
                escaping = false;
            } else if (char === "\\") {
                escaping = true;
            } else if (char === quote) {
                quote = undefined;
            }
            continue;
        }
        if (char === "'" || char === '"' || char === "`") {
            quote = char;
            continue;
        }
        if (char === ";" || char === "{" || char === "}") {
            result += "\n";
        }
    }
    return result.replace(/\n{3,}/g, "\n\n");
}

function renderGrid(values: string[]): string {
    const lines: string[] = [];
    for (let row = 0; row < 32; row += 1) {
        const line: string[] = [];
        for (let col = 0; col < 32; col += 1) {
            line.push(values[row + col * 32] ?? "");
        }
        lines.push(line.join(""));
    }
    return `${lines.join("\n")}\n`;
}

function renderHeightCounts(counts: Record<string, number>): string {
    return Object.entries(counts)
        .map(([height, count]) => `h=${height}: ${count}`)
        .join(", ");
}

function formatHeightCounts(counts: Record<string, number>): string {
    return renderHeightCounts(counts) || "(none)";
}

function formatCharList(chars: string[]): string {
    if (chars.length === 0) return "(none)";
    return chars
        .map((char) => (char === " " ? "`space`" : `\`${char}\``))
        .join(" ");
}

function displayChar(char: string): string {
    return char === " " ? "`space`" : char;
}

function escapeMarkdownCell(value: string): string {
    return value.replace(/\|/g, "\\|");
}

function orderedUnique<T>(values: T[]): T[] {
    return Array.from(new Set(values));
}

function positiveModulo(value: number, divisor: number): number {
    if (divisor <= 0) return 0;
    return ((value % divisor) + divisor) % divisor;
}

function quoteJs(value: string): string {
    return JSON.stringify(value);
}

function formatValue(value: number | undefined): string {
    return value === undefined ? "undefined" : String(value);
}

function toHex(value: number): string {
    return `U+${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function countOccurrences(input: string, needle: string): number {
    if (needle.length === 0) return 0;
    let count = 0;
    let index = 0;
    while ((index = input.indexOf(needle, index)) !== -1) {
        count += 1;
        index += needle.length;
    }
    return count;
}

function sniffFontFormat(buffer: Buffer): string {
    const signature = buffer.subarray(0, 4).toString("ascii");
    if (signature === "wOFF") return "woff";
    if (signature === "wOF2") return "woff2";
    if (signature === "OTTO") return "otf";
    return "ttf";
}

function readU16(buffer: Buffer, offset: number): number {
    if (offset + 2 > buffer.length) return 0;
    return buffer.readUInt16BE(offset);
}

function readI16(buffer: Buffer, offset: number): number {
    if (offset + 2 > buffer.length) return 0;
    return buffer.readInt16BE(offset);
}

function readU32(buffer: Buffer, offset: number): number {
    if (offset + 4 > buffer.length) return 0;
    return buffer.readUInt32BE(offset);
}

function defaultOutputDir(inputPath: string): string {
    const parsed = path.parse(inputPath);
    return path.join("tmp", `${parsed.name}-dissect`);
}

async function writeJson(filePath: string, value: unknown) {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
