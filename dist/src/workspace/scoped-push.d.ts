export declare const PRE_RECEIVE_HOOK: string;
export interface ScopedPushGrant {
    grantId: string;
    ref: string;
    expiresAt: number;
}
export interface CreateScopedPushGrantOptions {
    /** The runtime-controlled BARE repo the sandbox will push to. */
    repoDir: string;
    /** The single ref the push may create (e.g. refs/synth/agent1/run1). */
    ref: string;
    ttlMs?: number;
    now?: () => number;
}
/**
 * Install the hook and write a grant. The credential handed to the sandbox
 * carries only the transport secret; the AUTHORIZATION is this grant plus the
 * hook, so even a stolen credential can only create the one granted ref once.
 */
export declare function createScopedPushGrant(options: CreateScopedPushGrantOptions): Promise<ScopedPushGrant>;
export interface ScopedPushResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}
/** Push `localRef` from `workDir` to `remote` at the granted ref, with the hook enforcing scope. */
export declare function scopedPush(options: {
    workDir: string;
    remote: string;
    localRef: string;
    ref: string;
}): Promise<ScopedPushResult>;
