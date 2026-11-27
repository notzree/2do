import { setTimeout as delay } from "node:timers/promises";

const healthUrl = new URL(process.argv[2]);
const deadline = Date.now() + 120_000;

async function apiIsReady() {
	try {
		const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
		const health = await response.json();
		return response.ok && health?.status === "ok";
	} catch {
		return false;
	}
}

console.log(`Waiting for ${healthUrl} before starting the web server`);
while (!(await apiIsReady())) {
	if (Date.now() >= deadline) {
		throw new Error(`API did not become ready at ${healthUrl} within 120 seconds`);
	}
	await delay(250);
}
