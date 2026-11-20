import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientFrameId } from "../../core/types";
import { inheritedDependency } from "./inherit";

const id = (s: string) => s as ClientFrameId;

test("inherit: a dependency among the inherited frames maps to its new id and stays held", () => {
	const ids = new Map([["old-create", id("new-create")]]);
	assert.deepEqual(inheritedDependency({ dependsOn: id("old-create"), state: "held" }, ids), { dependsOn: "new-create", state: "held" });
	assert.deepEqual(inheritedDependency({ dependsOn: id("old-create"), state: "pending" }, ids), { dependsOn: "new-create", state: "pending" });
});

test("inherit: a held frame whose dependency the mirror does not carry waits on nothing (sim heavy seed 716094400)", () => {
	// The create committed in the predecessor and left its outbox; its body frames were still held in the mirror. Kept
	// as a dependency, the boot refold (nothing read yet) deleted them as frames of a create folded without the doc.
	assert.deepEqual(inheritedDependency({ dependsOn: id("committed-create"), state: "held" }, new Map()), { dependsOn: null, state: "pending" });
	assert.deepEqual(inheritedDependency({ dependsOn: id("committed-create"), state: "pending" }, new Map()), { dependsOn: null, state: "pending" });
});

test("inherit: no dependency keeps the state; a pre-schema-2 \"sent\" record is pending", () => {
	assert.deepEqual(inheritedDependency({ dependsOn: null, state: "pending" }, new Map()), { dependsOn: null, state: "pending" });
	assert.deepEqual(inheritedDependency({ dependsOn: null, state: "sent" }, new Map()), { dependsOn: null, state: "pending" });
});
