import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

const viemMock = vi.hoisted(() => {
    const readContract = vi.fn();
    const getStorageAt = vi.fn();
    const createPublicClient = vi.fn(() => ({
        readContract,
        getStorageAt,
    }));

    return {
        readContract,
        getStorageAt,
        createPublicClient,
        http: vi.fn((url: string) => ({ url })),
        getAddress: vi.fn((address: string) => address),
        keccak256: vi.fn(() => "0xslot"),
        concatHex: vi.fn((parts: string[]) => parts.join("")),
        padHex: vi.fn((hex: string) => hex),
        toHex: vi.fn((value: bigint) => `0x${value.toString(16)}`),
        maxUint256: (1n << 256n) - 1n,
    };
});

vi.mock("viem", () => viemMock);

import { fetchParcelHtml } from "../src/infra/onchain/parcelFetcher.js";

let tmpDir: string | null = null;

beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "parcel-fetcher-"));
    vi.clearAllMocks();
    viemMock.createPublicClient.mockReturnValue({
        readContract: viemMock.readContract,
        getStorageAt: viemMock.getStorageAt,
    });
});

afterEach(async () => {
    if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true });
        tmpDir = null;
    }
});

describe("fetchParcelHtml", () => {
    it("uses the explicit renderer version override instead of the token URI mapping", async () => {
        viemMock.readContract.mockImplementation(
            ({ functionName }: { functionName: string }) => {
                switch (functionName) {
                    case "tokenURIAddresses":
                        return "0x0000000000000000000000000000000000000002";
                    case "tokenToPlacement":
                        return 123n;
                    case "tokenToStatus":
                        return 0n;
                    case "tokenHTML":
                        return "<html></html>";
                    default:
                        throw new Error(`Unexpected function: ${functionName}`);
                }
            },
        );

        const result = await fetchParcelHtml("113", {
            outputDir: tmpDir ?? undefined,
            version: 2n,
            forceTerrainForDaydream: true,
        });

        expect(result.input.version).toEqual({
            value: 2n,
            source: "override",
        });
        expect(viemMock.getStorageAt).not.toHaveBeenCalled();
        expect(viemMock.readContract).toHaveBeenCalledWith(
            expect.objectContaining({
                functionName: "tokenURIAddresses",
                args: [2n],
            }),
        );
        expect(viemMock.readContract).toHaveBeenCalledWith(
            expect.objectContaining({
                functionName: "tokenHTML",
                args: [
                    0n,
                    123n,
                    10196n,
                    0n,
                    Array.from({ length: 16 }, () => 0n),
                ],
            }),
        );
    });
});
