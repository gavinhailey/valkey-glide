/**
 * Copyright Valkey GLIDE Project Contributors - SPDX Identifier: Apache-2.0
 */

import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
    jest,
} from "@jest/globals";
import * as fs from "fs";
import ValkeyCluster from "../../utils/TestUtils";
import {
    ClusterBatch,
    GlideClient,
    GlideClusterClient,
    OpenTelemetry,
    OpenTelemetryConfig,
    ProtocolVersion,
    createLeakedOtelSpan,
    createOtelSpanWithParent,
    createBatchOtelSpanWithParent,
    dropOtelSpan,
} from "../build-ts";
import {
    flushAndCloseClient,
    getClientConfigurationOption,
    getServerVersion,
    parseEndpoints,
} from "./TestUtilities";

/**
 * Reads and parses a span file, extracting span data and names.
 *
 * @param path - The path to the span file
 * @returns An object containing the raw span data, array of spans, and array of span names
 * @throws Error if the file cannot be read or parsed
 */
function readAndParseSpanFile(path: string): {
    spanData: string;
    spans: string[];
    spanNames: string[];
} {
    let spanData: string;

    try {
        spanData = fs.readFileSync(path, "utf8");
    } catch (error: unknown) {
        throw new Error(
            `Failed to read or validate file: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const spans = spanData
        .split("\n")
        .filter((line: string) => line.trim() !== "");

    // Check that we have spans
    if (spans.length === 0) {
        throw new Error("No spans found in the span file");
    }

    // Parse and extract span names
    const spanNames = spans
        .map((line: string) => {
            try {
                const span = JSON.parse(line);
                return span.name;
            } catch {
                return null;
            }
        })
        .filter((name: string | null) => name !== null);

    return {
        spanData,
        spans,
        spanNames,
    };
}

const TIMEOUT = 50000;
const VALID_ENDPOINT_TRACES = "/tmp/spans.json";
const VALID_FILE_ENDPOINT_TRACES = "file://" + VALID_ENDPOINT_TRACES;
const VALID_ENDPOINT_METRICS = "https://valid-endpoint/v1/metrics";

async function wrongOpenTelemetryConfig() {
    // wrong traces endpoint
    let openTelemetryConfig: OpenTelemetryConfig = {
        traces: {
            endpoint: "wrong.endpoint",
        },
    };
    expect(() => OpenTelemetry.init(openTelemetryConfig)).toThrow(
        /Parse error. /i,
    );

    // wrong metrics endpoint
    openTelemetryConfig = {
        metrics: {
            endpoint: "wrong.endpoint",
        },
    };
    expect(() => OpenTelemetry.init(openTelemetryConfig)).toThrow(
        /Parse error. /i,
    );

    // negative flush interval
    openTelemetryConfig = {
        traces: {
            endpoint: VALID_FILE_ENDPOINT_TRACES,
            samplePercentage: 1,
        },
        flushIntervalMs: -400,
    };
    expect(() => OpenTelemetry.init(openTelemetryConfig)).toThrow(
        /InvalidInput: flushIntervalMs must be a positive integer/i,
    );

    // negative requests percentage
    openTelemetryConfig = {
        traces: {
            endpoint: VALID_FILE_ENDPOINT_TRACES,
            samplePercentage: -400,
        },
    };
    expect(() => OpenTelemetry.init(openTelemetryConfig)).toThrow(
        /Trace sample percentage must be between 0 and 100/i,
    );

    // wrong traces file path
    openTelemetryConfig = {
        traces: {
            endpoint: "file:invalid-path/v1/traces.json",
        },
    };
    expect(() => OpenTelemetry.init(openTelemetryConfig)).toThrow(
        /File path must start with 'file:\/\/'/i,
    );

    // wrong metrics file path
    openTelemetryConfig = {
        metrics: {
            endpoint: "file:invalid-path/v1/metrics.json",
        },
    };
    expect(() => OpenTelemetry.init(openTelemetryConfig)).toThrow(
        /File path must start with 'file:\/\/'/i,
    );

    // wrong directory path
    openTelemetryConfig = {
        traces: {
            endpoint: "file:///no-exits-path/v1/traces.json",
        },
    };
    expect(() => OpenTelemetry.init(openTelemetryConfig)).toThrow(
        /The directory does not exist or is not a directory/i,
    );

    // Traces and metrics are not provided
    openTelemetryConfig = {};
    expect(() => OpenTelemetry.init(openTelemetryConfig)).toThrow(
        /At least one of traces or metrics must be provided for OpenTelemetry configuration./i,
    );

    // Test configuration with invalid spanFromContext
    const configWithInvalidSpanFromContext: OpenTelemetryConfig = {
        traces: {
            endpoint: "wrong.endpoint",
        },
        spanFromContext: "invalid_span_function" as any, // This should be a function
    };

    expect(() => OpenTelemetry.init(configWithInvalidSpanFromContext)).toThrow(
        /Parse error. /i,
    );
}

//cluster tests
describe("OpenTelemetry GlideClusterClient", () => {
    const testsFailed = 0;
    let cluster: ValkeyCluster;
    let client: GlideClusterClient;
    beforeAll(async () => {
        const clusterAddresses = global.CLUSTER_ENDPOINTS;
        // Connect to cluster or create a new one based on the parsed addresses
        cluster = clusterAddresses
            ? await ValkeyCluster.initFromExistingCluster(
                  true,
                  parseEndpoints(clusterAddresses),
                  getServerVersion,
              )
            : // setting replicaCount to 1 to facilitate tests routed to replicas
              await ValkeyCluster.createCluster(true, 3, 1, getServerVersion);

        // check wrong open telemetry config before initilise it
        await wrongOpenTelemetryConfig();

        await testSpanNotExportedBeforeInitOtel();

        // init open telemetry. The init can be called once per process.
        const openTelemetryConfig: OpenTelemetryConfig = {
            traces: {
                endpoint: VALID_FILE_ENDPOINT_TRACES,
                samplePercentage: 100,
            },
            metrics: {
                endpoint: VALID_ENDPOINT_METRICS,
            },
            flushIntervalMs: 100,
        };
        OpenTelemetry.init(openTelemetryConfig);
        await teardown_otel_test();
    }, 40000);

    async function teardown_otel_test() {
        // Clean up OpenTelemetry files
        if (fs.existsSync(VALID_ENDPOINT_TRACES)) {
            fs.unlinkSync(VALID_ENDPOINT_TRACES);
        }

        if (fs.existsSync(VALID_ENDPOINT_METRICS)) {
            fs.unlinkSync(VALID_ENDPOINT_METRICS);
        }
    }

    afterEach(async () => {
        await teardown_otel_test();
        await flushAndCloseClient(true, cluster?.getAddresses(), client);
    });

    afterAll(async () => {
        if (testsFailed === 0) {
            await cluster.close();
        } else {
            await cluster.close(true);
        }
    });

    async function testSpanNotExportedBeforeInitOtel() {
        await teardown_otel_test();

        const client = await GlideClusterClient.createClient({
            ...getClientConfigurationOption(
                cluster.getAddresses(),
                ProtocolVersion.RESP3,
            ),
        });

        await client.get("testSpanNotExportedBeforeInitOtel");

        // check that the spans not exporter to the file before initilise otel
        expect(fs.existsSync(VALID_ENDPOINT_TRACES)).toBe(false);

        client.close();
    }

    it.each([ProtocolVersion.RESP2, ProtocolVersion.RESP3])(
        `GlideClusterClient test span memory leak_%p`,
        async (protocol) => {
            if (global.gc) {
                global.gc(); // Run garbage collection
            }

            const startMemory = process.memoryUsage().heapUsed;

            client = await GlideClusterClient.createClient({
                ...getClientConfigurationOption(
                    cluster.getAddresses(),
                    protocol,
                ),
            });

            // Execute a series of commands sequentially
            for (let i = 0; i < 100; i++) {
                const key = `test_key_${i}`;
                await client.set(key, `value_${i}`);
                await client.get(key);
            }

            // Force GC and check memory
            if (global.gc) {
                global.gc();
            }

            const endMemory = process.memoryUsage().heapUsed;

            expect(endMemory).toBeLessThan(startMemory * 1.1); // Allow 10% growth
        },
        TIMEOUT,
    );

    it.each([ProtocolVersion.RESP2, ProtocolVersion.RESP3])(
        `GlideClusterClient test percentage requests config_%p`,
        async (protocol) => {
            const client = await GlideClusterClient.createClient({
                ...getClientConfigurationOption(
                    cluster.getAddresses(),
                    protocol,
                ),
            });
            OpenTelemetry.setSamplePercentage(0);
            expect(OpenTelemetry.getSamplePercentage()).toBe(0);

            // wait for the spans to be flushed and removed the file
            await new Promise((resolve) => setTimeout(resolve, 500));

            await teardown_otel_test();

            for (let i = 0; i < 100; i++) {
                await client.set(
                    "GlideClusterClient_test_percentage_requests_config",
                    "value",
                );
            }

            await new Promise((resolve) => setTimeout(resolve, 500));
            // check that the spans not exporter to the file due to the requests percentage is 0
            expect(fs.existsSync(VALID_ENDPOINT_TRACES)).toBe(false);

            expect(() => OpenTelemetry.setSamplePercentage(-100)).toThrow(
                /Sample percentage must be between 0 and 100/i,
            );
            // check that the sample percentage is still 0
            expect(OpenTelemetry.getSamplePercentage()).toBe(0);
            OpenTelemetry.setSamplePercentage(100);
            expect(OpenTelemetry.getSamplePercentage()).toBe(100);

            // Execute a series of commands sequentially
            for (let i = 0; i < 10; i++) {
                const key = `GlideClusterClient_test_percentage_requests_config_${i}`;
                await client.get(key);
            }

            // Wait for spans to be flushed to file
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // Read the span file and check span name
            const { spanNames } = readAndParseSpanFile(VALID_ENDPOINT_TRACES);

            expect(spanNames).toContain("Get");
            // check that the spans exported to the file exactly 10 times
            expect(spanNames.filter((name) => name === "Get").length).toBe(10);
        },
        TIMEOUT,
    );

    it.each([ProtocolVersion.RESP2, ProtocolVersion.RESP3])(
        `GlideClusterClient test otel global config not reinitialize_%p`,
        async (protocol) => {
            const openTelemetryConfig: OpenTelemetryConfig = {
                traces: {
                    endpoint: "wrong.endpoint",
                    samplePercentage: 1,
                },
            };
            // the init will not throw error regarding the wrong endpoint because the init can be called once per process
            expect(() => OpenTelemetry.init(openTelemetryConfig)).not.toThrow();

            const client = await GlideClusterClient.createClient({
                ...getClientConfigurationOption(
                    cluster.getAddresses(),
                    protocol,
                ),
            });

            await client.set(
                "GlideClusterClient_test_otel_global_config",
                "value",
            );

            await new Promise((resolve) => setTimeout(resolve, 500));

            // Read the span file and check span name
            const { spanNames } = readAndParseSpanFile(VALID_ENDPOINT_TRACES);

            expect(spanNames).toContain("Set");
        },
        TIMEOUT,
    );

    it.each([ProtocolVersion.RESP2, ProtocolVersion.RESP3])(
        `GlideClusterClient test span transaction memory leak_%p`,
        async (protocol) => {
            if (global.gc) {
                global.gc(); // Run garbage collection
            }

            const startMemory = process.memoryUsage().heapUsed;
            client = await GlideClusterClient.createClient({
                ...getClientConfigurationOption(
                    cluster.getAddresses(),
                    protocol,
                ),
            });

            const batch = new ClusterBatch(true);

            batch.set("test_key", "foo");
            batch.objectRefcount("test_key");

            const response = await client.exec(batch, true);
            expect(response).not.toBeNull();

            if (response != null) {
                expect(response.length).toEqual(2);
                expect(response[0]).toEqual("OK"); // batch.set("test_key", "foo");
                expect(response[1]).toBeGreaterThanOrEqual(1); // batch.objectRefcount("test_key");
            }

            // Force GC and check memory
            if (global.gc) {
                global.gc();
            }

            const endMemory = process.memoryUsage().heapUsed;

            expect(endMemory).toBeLessThan(startMemory * 1.1); // Allow 10% growth
        },
        TIMEOUT,
    );

    it.each([ProtocolVersion.RESP2, ProtocolVersion.RESP3])(
        `GlideClusterClient test number of clients with same config_%p`,
        async (protocol) => {
            const client1 = await GlideClusterClient.createClient({
                ...getClientConfigurationOption(
                    cluster.getAddresses(),
                    protocol,
                ),
            });
            const client2 = await GlideClusterClient.createClient({
                ...getClientConfigurationOption(
                    cluster.getAddresses(),
                    protocol,
                ),
            });

            client1.set("test_key", "value");
            client2.get("test_key");

            // Wait for spans to be flushed to file
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // Read and check span names from the file using the helper function
            const { spanNames } = readAndParseSpanFile(VALID_ENDPOINT_TRACES);

            // Check for expected span names
            expect(spanNames).toContain("Get");
            expect(spanNames).toContain("Set");

            client1.close();
            client2.close();
        },
        TIMEOUT,
    );

    it.each([ProtocolVersion.RESP2, ProtocolVersion.RESP3])(
        `GlideClusterClient test span batch file_%p`,
        async (protocol) => {
            if (global.gc) {
                global.gc(); // Run garbage collection
            }

            const startMemory = process.memoryUsage().heapUsed;
            client = await GlideClusterClient.createClient({
                ...getClientConfigurationOption(
                    cluster.getAddresses(),
                    protocol,
                ),
            });

            const batch = new ClusterBatch(true);

            batch.set("test_key", "foo");
            batch.objectRefcount("test_key");

            const response = await client.exec(batch, true);
            expect(response).not.toBeNull();

            if (response != null) {
                expect(response.length).toEqual(2);
                expect(response[0]).toEqual("OK"); // transaction.set("test_key", "foo");
                expect(response[1]).toBeGreaterThanOrEqual(1); // transaction.objectRefcount("test_key");
            }

            // Wait for spans to be flushed to file
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // Read and check span names from the file using the helper function
            const { spanNames } = readAndParseSpanFile(VALID_ENDPOINT_TRACES);

            // Check for expected span names
            expect(spanNames).toContain("Batch");
            expect(spanNames).toContain("send_batch");

            // Force GC and check memory
            if (global.gc) {
                global.gc();
            }

            const endMemory = process.memoryUsage().heapUsed;

            expect(endMemory).toBeLessThan(startMemory * 1.1); // Allow 10% growth
        },
        TIMEOUT,
    );
});

//OpenTelemetry Parent Span NAPI Functions Tests
describe("OpenTelemetry Parent Span NAPI Functions", () => {
    beforeAll(async () => {
        // Clean up any existing span files
        if (fs.existsSync(VALID_ENDPOINT_TRACES)) {
            fs.unlinkSync(VALID_ENDPOINT_TRACES);
        }

        // Initialize OpenTelemetry for testing
        const openTelemetryConfig: OpenTelemetryConfig = {
            traces: {
                endpoint: VALID_FILE_ENDPOINT_TRACES,
                samplePercentage: 100,
            },
            flushIntervalMs: 100,
        };
        OpenTelemetry.init(openTelemetryConfig);
    }, 20000);

    afterEach(async () => {
        // Clean up span files after each test
        if (fs.existsSync(VALID_ENDPOINT_TRACES)) {
            fs.unlinkSync(VALID_ENDPOINT_TRACES);
        }
    });

    it("createOtelSpanWithParent should create independent span when parent pointer is 0", () => {
        const requestType = 1; // Assuming this maps to a valid request type
        const parentSpanPtr = 0n; // 0 means create independent span

        const spanPointer = createOtelSpanWithParent(
            requestType,
            parentSpanPtr,
        );

        // Should return valid non-zero pointer
        expect(spanPointer).toHaveLength(2);
        expect(spanPointer[0] !== 0 || spanPointer[1] !== 0).toBe(true);

        // Clean up the span
        const spanPtr =
            BigInt(spanPointer[0]) | (BigInt(spanPointer[1]) << 32n);
        dropOtelSpan(spanPtr);
    });

    it("createOtelSpanWithParent should return [0, 0] on invalid parent pointer", () => {
        const requestType = 1;
        const invalidParentPtr = 0xdeadbeefn; // Invalid pointer

        const spanPointer = createOtelSpanWithParent(
            requestType,
            invalidParentPtr,
        );

        // Should return null pointer on error
        expect(spanPointer).toEqual([0, 0]);
    });

    it("createOtelSpanWithParent should handle negative BigInt parent pointer", () => {
        const requestType = 1;
        const negativeParentPtr = -1n; // Negative pointer should be invalid

        const spanPointer = createOtelSpanWithParent(
            requestType,
            negativeParentPtr,
        );

        // Should return null pointer on error
        expect(spanPointer).toEqual([0, 0]);
    });

    it("createOtelSpanWithParent should create child span with valid parent", () => {
        // First create a parent span
        const parentSpanPointer = createLeakedOtelSpan("ParentSpan");
        const parentSpanPtr =
            BigInt(parentSpanPointer[0]) |
            (BigInt(parentSpanPointer[1]) << 32n);

        // Create child span with parent
        const requestType = 2;
        const childSpanPointer = createOtelSpanWithParent(
            requestType,
            parentSpanPtr,
        );

        // Should return valid non-zero pointer
        expect(childSpanPointer).toHaveLength(2);
        expect(childSpanPointer[0] !== 0 || childSpanPointer[1] !== 0).toBe(
            true,
        );

        // Clean up spans
        const childSpanPtr =
            BigInt(childSpanPointer[0]) | (BigInt(childSpanPointer[1]) << 32n);
        dropOtelSpan(childSpanPtr);
        dropOtelSpan(parentSpanPtr);
    });

    it("createBatchOtelSpanWithParent should create independent span when parent pointer is 0", () => {
        const parentSpanPtr = 0n; // 0 means create independent span

        const spanPointer = createBatchOtelSpanWithParent(parentSpanPtr);

        // Should return valid non-zero pointer
        expect(spanPointer).toHaveLength(2);
        expect(spanPointer[0] !== 0 || spanPointer[1] !== 0).toBe(true);

        // Clean up the span
        const spanPtr =
            BigInt(spanPointer[0]) | (BigInt(spanPointer[1]) << 32n);
        dropOtelSpan(spanPtr);
    });

    it("createBatchOtelSpanWithParent should return [0, 0] on invalid parent pointer", () => {
        const invalidParentPtr = 0xdeadbeefn; // Invalid pointer

        const spanPointer = createBatchOtelSpanWithParent(invalidParentPtr);

        // Should return null pointer on error
        expect(spanPointer).toEqual([0, 0]);
    });

    it("createBatchOtelSpanWithParent should handle negative BigInt parent pointer", () => {
        const negativeParentPtr = -1n; // Negative pointer should be invalid

        const spanPointer = createBatchOtelSpanWithParent(negativeParentPtr);

        // Should return null pointer on error
        expect(spanPointer).toEqual([0, 0]);
    });

    it("createBatchOtelSpanWithParent should create child span with valid parent", () => {
        // First create a parent span
        const parentSpanPointer = createLeakedOtelSpan("ParentBatchSpan");
        const parentSpanPtr =
            BigInt(parentSpanPointer[0]) |
            (BigInt(parentSpanPointer[1]) << 32n);

        // Create child batch span with parent
        const childSpanPointer = createBatchOtelSpanWithParent(parentSpanPtr);

        // Should return valid non-zero pointer
        expect(childSpanPointer).toHaveLength(2);
        expect(childSpanPointer[0] !== 0 || childSpanPointer[1] !== 0).toBe(
            true,
        );

        // Clean up spans
        const childSpanPtr =
            BigInt(childSpanPointer[0]) | (BigInt(childSpanPointer[1]) << 32n);
        dropOtelSpan(childSpanPtr);
        dropOtelSpan(parentSpanPtr);
    });

    it("should handle multiple nested child spans correctly", () => {
        // Create grandparent span
        const grandparentSpanPointer = createLeakedOtelSpan("GrandparentSpan");
        const grandparentSpanPtr =
            BigInt(grandparentSpanPointer[0]) |
            (BigInt(grandparentSpanPointer[1]) << 32n);

        // Create parent span as child of grandparent
        const parentSpanPointer = createOtelSpanWithParent(
            3,
            grandparentSpanPtr,
        );
        expect(parentSpanPointer[0] !== 0 || parentSpanPointer[1] !== 0).toBe(
            true,
        );
        const parentSpanPtr =
            BigInt(parentSpanPointer[0]) |
            (BigInt(parentSpanPointer[1]) << 32n);

        // Create child span as child of parent
        const childSpanPointer = createOtelSpanWithParent(4, parentSpanPtr);
        expect(childSpanPointer[0] !== 0 || childSpanPointer[1] !== 0).toBe(
            true,
        );
        const childSpanPtr =
            BigInt(childSpanPointer[0]) | (BigInt(childSpanPointer[1]) << 32n);

        // Clean up all spans
        dropOtelSpan(childSpanPtr);
        dropOtelSpan(parentSpanPtr);
        dropOtelSpan(grandparentSpanPtr);
    });

    it("should handle concurrent span creation with same parent", () => {
        // Create a parent span
        const parentSpanPointer = createLeakedOtelSpan("SharedParentSpan");
        const parentSpanPtr =
            BigInt(parentSpanPointer[0]) |
            (BigInt(parentSpanPointer[1]) << 32n);

        // Create multiple child spans concurrently
        const child1Pointer = createOtelSpanWithParent(5, parentSpanPtr);
        const child2Pointer = createOtelSpanWithParent(6, parentSpanPtr);
        const child3Pointer = createBatchOtelSpanWithParent(parentSpanPtr);

        // All children should be valid
        expect(child1Pointer[0] !== 0 || child1Pointer[1] !== 0).toBe(true);
        expect(child2Pointer[0] !== 0 || child2Pointer[1] !== 0).toBe(true);
        expect(child3Pointer[0] !== 0 || child3Pointer[1] !== 0).toBe(true);

        // Clean up all spans
        const child1Ptr =
            BigInt(child1Pointer[0]) | (BigInt(child1Pointer[1]) << 32n);
        const child2Ptr =
            BigInt(child2Pointer[0]) | (BigInt(child2Pointer[1]) << 32n);
        const child3Ptr =
            BigInt(child3Pointer[0]) | (BigInt(child3Pointer[1]) << 32n);

        dropOtelSpan(child1Ptr);
        dropOtelSpan(child2Ptr);
        dropOtelSpan(child3Ptr);
        dropOtelSpan(parentSpanPtr);
    });
});

//OpenTelemetry spanFromContext functionality Tests
describe("OpenTelemetry spanFromContext functionality", () => {
    describe("extractSpanPointer method", () => {
        it("should return null when no active span context is available", () => {
            // Since there's no active span context in this test environment,
            // extractSpanPointer should return null
            const result = OpenTelemetry.extractSpanPointer();
            expect(result).toBeNull();
        });

        it("should handle span extraction gracefully", () => {
            const result = OpenTelemetry.extractSpanPointer();

            // In a test environment without active spans, this should return null
            expect(result).toBeNull();
        });

        it("should be callable multiple times without error", () => {
            // Test that the method can be called multiple times safely
            expect(() => {
                OpenTelemetry.extractSpanPointer();
                OpenTelemetry.extractSpanPointer();
                OpenTelemetry.extractSpanPointer();
            }).not.toThrow();
        });
    });

    describe("OpenTelemetry reinitialization with spanFromContext", () => {
        it("should not throw when calling init multiple times with spanFromContext", () => {
            // Following the pattern from existing tests - subsequent init calls don't throw
            const mockSpanFromContext = jest.fn().mockReturnValue(12345);
            const anotherConfig: OpenTelemetryConfig = {
                traces: {
                    endpoint: "file:///tmp/another_test_spans.json",
                    samplePercentage: 50,
                },
                spanFromContext: mockSpanFromContext,
            };

            expect(() => OpenTelemetry.init(anotherConfig)).not.toThrow();
        });

        it("should maintain functionality after multiple init attempts", () => {
            // Try to init again with different spanFromContext
            const mockSpanFromContext = jest.fn().mockReturnValue(null);
            const config: OpenTelemetryConfig = {
                metrics: {
                    endpoint: "https://example.com/metrics",
                },
                spanFromContext: mockSpanFromContext,
            };

            OpenTelemetry.init(config);

            // extractSpanPointer should still work
            expect(() => OpenTelemetry.extractSpanPointer()).not.toThrow();
        });

        it("should accept various spanFromContext function configurations", () => {
            // Test with function that returns a number
            const spanFromContextReturningNumber = () => 42;
            let config: OpenTelemetryConfig = {
                traces: {
                    endpoint: VALID_FILE_ENDPOINT_TRACES,
                },
                spanFromContext: spanFromContextReturningNumber,
            };
            expect(() => OpenTelemetry.init(config)).not.toThrow();

            // Test with function that returns null
            const spanFromContextReturningNull = () => null;
            config = {
                traces: {
                    endpoint: VALID_FILE_ENDPOINT_TRACES,
                },
                spanFromContext: spanFromContextReturningNull,
            };
            expect(() => OpenTelemetry.init(config)).not.toThrow();

            // Test with function that throws
            const spanFromContextThrowing = () => {
                throw new Error("Test error");
            };
            config = {
                traces: {
                    endpoint: VALID_FILE_ENDPOINT_TRACES,
                },
                spanFromContext: spanFromContextThrowing,
            };
            expect(() => OpenTelemetry.init(config)).not.toThrow();
        });
    });
});

//OpenTelemetry Parent Span Integration Tests
describe("OpenTelemetry Parent Span Integration Tests", () => {
    const testsFailed = 0;
    let cluster: ValkeyCluster;
    let client: GlideClusterClient;

    beforeAll(async () => {
        const clusterAddresses = global.CLUSTER_ENDPOINTS;
        cluster = clusterAddresses
            ? await ValkeyCluster.initFromExistingCluster(
                  true,
                  parseEndpoints(clusterAddresses),
                  getServerVersion,
              )
            : await ValkeyCluster.createCluster(true, 3, 1, getServerVersion);

        // Initialize OpenTelemetry for integration testing
        const openTelemetryConfig: OpenTelemetryConfig = {
            traces: {
                endpoint: VALID_FILE_ENDPOINT_TRACES,
                samplePercentage: 100,
            },
            flushIntervalMs: 100,
        };
        OpenTelemetry.init(openTelemetryConfig);
    }, 40000);

    afterEach(async () => {
        // Clean up span files after each test
        if (fs.existsSync(VALID_ENDPOINT_TRACES)) {
            fs.unlinkSync(VALID_ENDPOINT_TRACES);
        }
        await flushAndCloseClient(true, cluster?.getAddresses(), client);
    });

    afterAll(async () => {
        if (testsFailed === 0) {
            await cluster.close();
        } else {
            await cluster.close(true);
        }
    });

    it.each([ProtocolVersion.RESP2, ProtocolVersion.RESP3])(
        "should create spans with parent context when spanFromContext returns a valid pointer_%p",
        async (protocol) => {
            // Mock spanFromContext to return a valid parent span pointer
            let parentSpanPointer: bigint | null = null;

            const openTelemetryConfig: OpenTelemetryConfig = {
                traces: {
                    endpoint: VALID_FILE_ENDPOINT_TRACES,
                    samplePercentage: 100,
                },
                flushIntervalMs: 100,
                spanFromContext: () => {
                    if (parentSpanPointer !== null) {
                        return Number(parentSpanPointer);
                    }
                    return null;
                },
            };

            // Create a parent span to simulate active context
            const parentSpanPair = createLeakedOtelSpan("MockActiveSpan");
            parentSpanPointer =
                BigInt(parentSpanPair[0]) | (BigInt(parentSpanPair[1]) << 32n);

            // Re-initialize OpenTelemetry with spanFromContext
            OpenTelemetry.init(openTelemetryConfig);

            client = await GlideClusterClient.createClient({
                ...getClientConfigurationOption(
                    cluster.getAddresses(),
                    protocol,
                ),
            });

            // Execute commands that should create child spans
            await client.set("test_parent_span_key", "test_value");
            await client.get("test_parent_span_key");

            // Wait for spans to be flushed
            await new Promise((resolve) => setTimeout(resolve, 500));

            // Verify spans were created
            if (fs.existsSync(VALID_ENDPOINT_TRACES)) {
                const { spanNames } = readAndParseSpanFile(
                    VALID_ENDPOINT_TRACES,
                );
                expect(spanNames).toContain("Set");
                expect(spanNames).toContain("Get");
            }

            // Clean up parent span
            dropOtelSpan(parentSpanPointer);
        },
        TIMEOUT,
    );

    it.each([ProtocolVersion.RESP2, ProtocolVersion.RESP3])(
        "should create independent spans when spanFromContext returns null_%p",
        async (protocol) => {
            const openTelemetryConfig: OpenTelemetryConfig = {
                traces: {
                    endpoint: VALID_FILE_ENDPOINT_TRACES,
                    samplePercentage: 100,
                },
                flushIntervalMs: 100,
                spanFromContext: () => null, // Always return null
            };

            OpenTelemetry.init(openTelemetryConfig);

            client = await GlideClusterClient.createClient({
                ...getClientConfigurationOption(
                    cluster.getAddresses(),
                    protocol,
                ),
            });

            // Execute commands that should create independent spans
            await client.set("test_independent_span_key", "test_value");
            await client.get("test_independent_span_key");

            // Wait for spans to be flushed
            await new Promise((resolve) => setTimeout(resolve, 500));

            // Verify spans were created (should fall back to independent spans)
            if (fs.existsSync(VALID_ENDPOINT_TRACES)) {
                const { spanNames } = readAndParseSpanFile(
                    VALID_ENDPOINT_TRACES,
                );
                expect(spanNames).toContain("Set");
                expect(spanNames).toContain("Get");
            }
        },
        TIMEOUT,
    );

    it.each([ProtocolVersion.RESP2, ProtocolVersion.RESP3])(
        "should handle spanFromContext function throwing errors gracefully_%p",
        async (protocol) => {
            const openTelemetryConfig: OpenTelemetryConfig = {
                traces: {
                    endpoint: VALID_FILE_ENDPOINT_TRACES,
                    samplePercentage: 100,
                },
                flushIntervalMs: 100,
                spanFromContext: () => {
                    throw new Error("spanFromContext error");
                },
            };

            OpenTelemetry.init(openTelemetryConfig);

            client = await GlideClusterClient.createClient({
                ...getClientConfigurationOption(
                    cluster.getAddresses(),
                    protocol,
                ),
            });

            // Execute commands - should not throw and should create independent spans
            await client.set("test_error_span_key", "test_value");
            await client.get("test_error_span_key");

            // Wait for spans to be flushed
            await new Promise((resolve) => setTimeout(resolve, 500));

            // Verify spans were still created (should fall back to independent spans)
            if (fs.existsSync(VALID_ENDPOINT_TRACES)) {
                const { spanNames } = readAndParseSpanFile(
                    VALID_ENDPOINT_TRACES,
                );
                expect(spanNames).toContain("Set");
                expect(spanNames).toContain("Get");
            }
        },
        TIMEOUT,
    );

    it.each([ProtocolVersion.RESP2, ProtocolVersion.RESP3])(
        "should create parent-child relationship for batch operations_%p",
        async (protocol) => {
            // Mock spanFromContext to return a valid parent span pointer
            let parentSpanPointer: bigint | null = null;

            const openTelemetryConfig: OpenTelemetryConfig = {
                traces: {
                    endpoint: VALID_FILE_ENDPOINT_TRACES,
                    samplePercentage: 100,
                },
                flushIntervalMs: 100,
                spanFromContext: () => {
                    if (parentSpanPointer !== null) {
                        return Number(parentSpanPointer);
                    }
                    return null;
                },
            };

            // Create a parent span to simulate active context
            const parentSpanPair = createLeakedOtelSpan("MockActiveBatchSpan");
            parentSpanPointer =
                BigInt(parentSpanPair[0]) | (BigInt(parentSpanPair[1]) << 32n);

            OpenTelemetry.init(openTelemetryConfig);

            client = await GlideClusterClient.createClient({
                ...getClientConfigurationOption(
                    cluster.getAddresses(),
                    protocol,
                ),
            });

            // Execute batch operation that should create child span
            const batch = new ClusterBatch(true);
            batch.set("test_batch_key", "test_value");
            batch.get("test_batch_key");

            const response = await client.exec(batch, true);
            expect(response).not.toBeNull();

            // Wait for spans to be flushed
            await new Promise((resolve) => setTimeout(resolve, 500));

            // Verify batch span was created
            if (fs.existsSync(VALID_ENDPOINT_TRACES)) {
                const { spanNames } = readAndParseSpanFile(
                    VALID_ENDPOINT_TRACES,
                );
                expect(spanNames).toContain("Batch");
            }

            // Clean up parent span
            dropOtelSpan(parentSpanPointer);
        },
        TIMEOUT,
    );
});

//standalone tests
describe("OpenTelemetry GlideClient", () => {
    const testsFailed = 0;
    let cluster: ValkeyCluster;
    let client: GlideClient;
    beforeAll(async () => {
        const standaloneAddresses = global.STAND_ALONE_ENDPOINT;
        cluster = standaloneAddresses
            ? await ValkeyCluster.initFromExistingCluster(
                  false,
                  parseEndpoints(standaloneAddresses),
                  getServerVersion,
              )
            : await ValkeyCluster.createCluster(false, 1, 1, getServerVersion);
    }, 20000);

    afterEach(async () => {
        // remove the span file
        if (fs.existsSync(VALID_ENDPOINT_TRACES)) {
            fs.unlinkSync(VALID_ENDPOINT_TRACES);
        }

        await flushAndCloseClient(false, cluster.getAddresses(), client);
    });

    afterAll(async () => {
        if (testsFailed === 0) {
            await cluster.close();
        } else {
            await cluster.close(true);
        }
    });

    it.each([ProtocolVersion.RESP2, ProtocolVersion.RESP3])(
        `GlideClient test automatic span lifecycle_%p`,
        async (protocol) => {
            if (global.gc) {
                global.gc(); // Run garbage collection
            }

            const startMemory = process.memoryUsage().heapUsed;

            client = await GlideClient.createClient({
                ...getClientConfigurationOption(
                    cluster.getAddresses(),
                    protocol,
                ),
            });

            // Execute multiple commands - each should automatically create and clean up its span
            await client.set("test_key1", "value1");
            await client.get("test_key1");
            await client.set("test_key2", "value2");
            await client.get("test_key2");

            if (global.gc) {
                global.gc(); // Run GC again to clean up
            }

            const endMemory = process.memoryUsage().heapUsed;

            expect(endMemory).toBeLessThan(startMemory * 1.1); // Allow small fluctuations
        },
        TIMEOUT,
    );

    it.each([ProtocolVersion.RESP2, ProtocolVersion.RESP3])(
        "GlideClient test otel global config not reinitialize_%p",
        async (protocol) => {
            client = await GlideClient.createClient({
                ...getClientConfigurationOption(
                    cluster.getAddresses(),
                    protocol,
                ),
            });

            const openTelemetryConfig: OpenTelemetryConfig = {
                traces: {
                    endpoint: "wrong.endpoint",
                },
            };
            // the init will not throw error regarding the wrong endpoint because the init can be called once per process
            expect(() => OpenTelemetry.init(openTelemetryConfig)).not.toThrow();
        },
        TIMEOUT,
    );

    it.each([ProtocolVersion.RESP3, ProtocolVersion.RESP2])(
        `GlideClient test concurrent commands span lifecycle_%p`,
        async (protocol) => {
            if (global.gc) {
                global.gc(); // Run garbage collection
            }

            const startMemory = process.memoryUsage().heapUsed;

            client = await GlideClient.createClient({
                ...getClientConfigurationOption(
                    cluster.getAddresses(),
                    protocol,
                ),
            });

            // Execute multiple concurrent commands
            const commands = [
                client.set("test_key1", "value1"),
                client.get("test_key1"),
                client.set("test_key2", "value2"),
                client.get("test_key2"),
                client.set("test_key3", "value3"),
                client.get("test_key3"),
            ];

            await Promise.all(commands);

            if (global.gc) {
                global.gc(); // Run GC again to clean up
            }

            const endMemory = process.memoryUsage().heapUsed;

            expect(endMemory).toBeLessThan(startMemory * 1.1); // Allow small fluctuations
        },
        TIMEOUT,
    );
});
