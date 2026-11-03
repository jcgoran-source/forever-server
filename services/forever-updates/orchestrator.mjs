// Each stage is awaited separately so a failure cannot short-circuit later
// collectors or the scheduled briefing. Keep the stages sequential: Blizzard
// and Wowhead both perform read-modify-write operations on the briefing state.
export async function runIndependentStages(stages, logError = console.error) {
  const results = [];

  for (const [name, run] of stages) {
    try {
      const value = await run();
      results.push({ name, ok: true, value });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(name + ' failed: ' + message, error);
      results.push({ name, ok: false, error: message });
    }
  }

  return results;
}
