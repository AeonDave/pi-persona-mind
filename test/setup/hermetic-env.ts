/**
 * Test-process choke point: a developer shell or CI runner may export pi-persona settings that
 * deliberately alter extension registration, capture, scope, or persistence. Clear that namespace
 * before any test module loads; individual tests can still set the variable they exercise.
 */
for (const key of Object.keys(process.env)) {
	if (key === "PI_AGENT_DIR" || key.startsWith("PI_PERSONA_")) delete process.env[key];
}
