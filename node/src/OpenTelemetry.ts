/**
 * Copyright Valkey GLIDE Project Contributors - SPDX Identifier: Apache-2.0
 */

import {
    ConfigurationError,
    InitOpenTelemetry,
    Logger,
    OpenTelemetryConfig,
} from ".";

/**
 * ⚠️ OpenTelemetry can only be initialized once per process. Calling `OpenTelemetry.init()` more than once will be ignored.
 * If you need to change configuration, restart the process with new settings.
 * ### OpenTelemetry
 *
 * - **openTelemetryConfig**: Use this object to configure OpenTelemetry exporters and options.
 *   - **traces**: (optional) Configure trace exporting.
 *     - **endpoint**: The collector endpoint for traces. Supported protocols:
 *       - `http://` or `https://` for HTTP/HTTPS
 *       - `grpc://` for gRPC
 *       - `file://` for local file export (see below)
 *     - **samplePercentage**: (optional) The percentage of requests to sample and create a span for, used to measure command duration. Must be between 0 and 100. Defaults to 1 if not specified.
 *       Note: There is a tradeoff between sampling percentage and performance. Higher sampling percentages will provide more detailed telemetry data but will impact performance.
 *       It is recommended to keep this number low (1-5%) in production environments unless you have specific needs for higher sampling rates.
 *     - **spanFromContext**: (optional) A callback function to extract span context from the current execution context for creating parent-child span relationships.
 *   - **metrics**: (optional) Configure metrics exporting.
 *     - **endpoint**: The collector endpoint for metrics. Same protocol rules as above.
 *   - **flushIntervalMs**: (optional) Interval in milliseconds for flushing data to the collector. Must be a positive integer. Defaults to 5000ms if not specified.
 *
 * #### File Exporter Details
 * - For `file://` endpoints:
 *   - The path must start with `file://` (e.g., `file:///tmp/otel` or `file:///tmp/otel/traces.json`).
 *   - If the path is a directory or lacks a file extension, data is written to `signals.json` in that directory.
 *   - If the path includes a filename with an extension, that file is used as-is.
 *   - The parent directory must already exist; otherwise, initialization will fail with an InvalidInput error.
 *   - If the target file exists, new data is appended (not overwritten).
 *
 * #### Validation Rules
 * - `flushIntervalMs` must be a positive integer.
 * - `samplePercentage` must be between 0 and 100.
 * - File exporter paths must start with `file://` and have an existing parent directory.
 * - Invalid configuration will throw an error synchronously when calling `OpenTelemetry.init()`.
 */
export class OpenTelemetry {
    private static _instance: OpenTelemetry | null = null;
    private static openTelemetryConfig: OpenTelemetryConfig | null = null;

    /**
     * Singleton class for managing OpenTelemetry configuration and operations.
     * This class provides a centralized way to initialize OpenTelemetry and control
     * sampling behavior at runtime.
     *
     * Example usage:
     * ```typescript
     * import { OpenTelemetry, OpenTelemetryConfig } from "@valkey/valkey-glide";
     * import { trace, context } from '@opentelemetry/api';
     *
     * let openTelemetryConfig: OpenTelemetryConfig = {
     *  traces: {
     *    endpoint: "http://localhost:4318/v1/traces",
     *    samplePercentage: 10, // Optional, defaults to 1. Can also be changed at runtime via setSamplePercentage().
     *  },
     *  metrics: {
     *    endpoint: "http://localhost:4318/v1/metrics",
     *  },
     *  flushIntervalMs: 1000, // Optional, defaults to 5000
     *  spanFromContext: () => {
     *    const span = trace.getActiveSpan(context.active());
     *    if (span && span.spanContext().traceId) {
     *      // Extract span information and create a GLIDE span
     *      // This requires creating a parent span first
     *      const spanPtr = createNamedOtelSpan(span.attributes?.['operation.name'] || 'request');
     *      return Number(BigInt(spanPtr[0]) | (BigInt(spanPtr[1]) << 32n));
     *    }
     *    return null;
     *  },
     * };
     * OpenTelemetry.init(openTelemetryConfig);
     * ```
     *
     * @param openTelemetryConfig - Configuration object for telemetry collection and exporting.
     */
    public static init(openTelemetryConfig: OpenTelemetryConfig): void {
        if (this._instance) {
            Logger.log(
                "warn",
                "GlideOpenTelemetry",
                "OpenTelemetry already initialized - ignoring new configuration",
            );
            return;
        }

        if (!openTelemetryConfig || typeof openTelemetryConfig !== "object") {
            throw new ConfigurationError(
                "OpenTelemetry configuration is required.",
            );
        }

        this.internalInit(openTelemetryConfig);
        Logger.log(
            "info",
            "GlideOpenTelemetry",
            "OpenTelemetry initialized with config: " +
                JSON.stringify({
                    ...openTelemetryConfig,
                    // Don't log the spanFromContext function
                    spanFromContext: openTelemetryConfig.spanFromContext
                        ? "[Function]"
                        : undefined,
                }),
        );
    }

    private static internalInit(openTelemetryConfig: OpenTelemetryConfig) {
        this.openTelemetryConfig = openTelemetryConfig;
        // Extract the native config without the spanFromContext callback
        const { spanFromContext, ...nativeConfig } = openTelemetryConfig;
        InitOpenTelemetry(nativeConfig);
        this._instance = new OpenTelemetry();
    }

    /**
     * Gets the current OpenTelemetry instance.
     * @returns The OpenTelemetry instance if initialized, null otherwise.
     */
    public static get instance(): OpenTelemetry | null {
        return this._instance;
    }

    /**
     * Sets the percentage of requests to be sampled and traced. Must be a value between 0 and 100.
     * This setting only affects traces, not metrics.
     *
     * @param samplePercentage - The percentage of requests to sample (0-100).
     * @throws ConfigurationError If the percentage is invalid or OpenTelemetry is not initialized.
     */
    public static setSamplePercentage(samplePercentage: number): void {
        if (!this._instance) {
            throw new ConfigurationError("OpenTelemetry is not initialized.");
        }

        if (
            typeof samplePercentage !== "number" ||
            samplePercentage < 0 ||
            samplePercentage > 100
        ) {
            throw new ConfigurationError(
                "Sample percentage must be a number between 0 and 100.",
            );
        }

        Logger.log(
            "info",
            "GlideOpenTelemetry",
            `Setting sample percentage to: ${samplePercentage}`,
        );
    }

    /**
     * Extract span pointer from the current execution context using the configured spanFromContext callback.
     * This method safely calls the user-provided spanFromContext function and handles any errors gracefully.
     *
     * @returns BigInt span pointer if a parent span is available, null otherwise
     */
    public static extractSpanPointer(): bigint | null {
        if (!this.openTelemetryConfig?.spanFromContext) {
            return null;
        }

        try {
            const spanPtr = this.openTelemetryConfig.spanFromContext();
            return spanPtr !== null && spanPtr !== undefined
                ? BigInt(spanPtr)
                : null;
        } catch (error) {
            Logger.log(
                "warn",
                "GlideOpenTelemetry",
                `spanFromContext function threw an error: ${error}. Falling back to independent span creation.`,
            );
            return null;
        }
    }

    /**
     * Set the percentage of requests to be sampled and traced. Must be a value between 0 and 100.
     * This setting only affects traces, not metrics.
     *
     * @param samplePercentage - The percentage of requests to sample (0-100).
     * @throws ConfigurationError If the percentage is invalid or OpenTelemetry is not initialized.
     */
    public setSamplePercentage(samplePercentage: number): void {
        OpenTelemetry.setSamplePercentage(samplePercentage);
    }

    private constructor() {
        // Private constructor to prevent direct instantiation
    }
}
