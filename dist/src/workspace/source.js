export function normalizeRelative(path) {
    const parts = [];
    for (const raw of path.replace(/\\/g, "/").split("/")) {
        if (!raw || raw === ".")
            continue;
        if (raw === "..")
            parts.pop();
        else
            parts.push(raw);
    }
    return parts.join("/");
}
