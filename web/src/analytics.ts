// Community source: telemetry is disabled. These exports preserve the UI API.
export type AnalyticsProperties = Record<string, string | number | boolean | null | undefined>;
export function initializeAnalytics(): void {}
export function captureAnalytics(_event: string, _properties: AnalyticsProperties = {}): void {}
export function identifyAnalyticsUser(_userId: string, _properties: AnalyticsProperties = {}): void {}
export function resetAnalyticsUser(): void {}
export function registerAnalyticsProperties(_properties: AnalyticsProperties): void {}
export function flushAnalytics(): void {}
