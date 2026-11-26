export declare const SKIP_CODES: Set<string>;
export interface GuiVerdict { available: boolean; reason: string }
export declare function detectGui(options?: { env?: Record<string, string | undefined>; platform?: string; macSession?: () => string }): GuiVerdict;
export interface SelfCheckVerdict { outcome: 'pass' | 'skip' | 'fail'; reason: string; lines: string[] }
export declare function classify(stdout: string): SelfCheckVerdict;
