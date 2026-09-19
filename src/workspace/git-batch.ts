import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";

class ByteReader {
  #buffer: Buffer = Buffer.alloc(0);
  constructor(private readonly stream: Readable) {}

  async line(): Promise<string> {
    while (true) {
      const index = this.#buffer.indexOf(0x0a);
      if (index >= 0) {
        const line = this.#buffer.subarray(0, index).toString("utf8");
        this.#buffer = this.#buffer.subarray(index + 1);
        return line;
      }
      await this.#more();
    }
  }

  async bytes(length: number): Promise<Buffer> {
    while (this.#buffer.length < length) await this.#more();
    const out = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return out;
  }

  async #more(): Promise<void> {
    const chunk = this.stream.read() as Buffer | null;
    if (chunk) {
      this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
      return;
    }
    if ((this.stream as Readable & { readableEnded?: boolean }).readableEnded) throw new Error("git cat-file stream ended");
    await once(this.stream, "readable");
  }
}

/** Persistent native `git cat-file --batch` reader shared by one repository. */
export class GitCatFileBatch {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #reader: ByteReader;
  #chain: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: { gitDir: string; gitBin?: string; env?: NodeJS.ProcessEnv }) {
    this.#child = spawn(options.gitBin ?? "git", [`--git-dir=${options.gitDir}`, "cat-file", "--batch"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0" },
    });
    // Drain stderr continuously. A long-lived batch process can otherwise block
    // if Git emits enough warnings/errors to fill the stderr pipe.
    this.#child.stderr.on("data", () => {});
    this.#reader = new ByteReader(this.#child.stdout);
  }

  async read(object: string): Promise<{ objectId: string; type: string; bytes: Uint8Array }> {
    if (this.#closed) throw new Error("git cat-file batch is closed");
    const task = this.#chain.then(() => this.#readOne(object));
    this.#chain = task.catch(() => {});
    return task;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    if (this.#child.exitCode === null) {
      await Promise.race([
        once(this.#child, "close"),
        new Promise<void>((resolve) => setTimeout(() => { this.#child.kill("SIGTERM"); resolve(); }, 1_000)),
      ]);
    }
  }

  async #readOne(object: string): Promise<{ objectId: string; type: string; bytes: Uint8Array }> {
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(`${object}\n`, (error) => error ? reject(error) : resolve());
    });
    const header = await this.#reader.line();
    if (header.endsWith(" missing")) throw new Error(`Git object missing: ${object}`);
    const [objectId, type, sizeText] = header.split(" ");
    const size = Number(sizeText);
    if (!objectId || !type || !Number.isFinite(size)) throw new Error(`Invalid git cat-file header: ${header}`);
    const payload = await this.#reader.bytes(size + 1);
    if (payload[payload.length - 1] !== 0x0a) throw new Error("Invalid git cat-file framing");
    const bytes = payload.subarray(0, size);
    return { objectId, type, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice() };
  }
}
