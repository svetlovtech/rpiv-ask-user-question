import { rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach } from "vitest";
beforeEach(() => {
	rmSync(join(process.env.HOME!, ".config", "rpiv-ask-user-question", "config.json"), { force: true });
});
