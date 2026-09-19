/** Persistent native `git cat-file --batch` reader shared by one repository. */
export declare class GitCatFileBatch {
    #private;
    constructor(options: {
        gitDir: string;
        gitBin?: string;
        env?: NodeJS.ProcessEnv;
    });
    read(object: string): Promise<{
        objectId: string;
        type: string;
        bytes: Uint8Array;
    }>;
    close(): Promise<void>;
}
