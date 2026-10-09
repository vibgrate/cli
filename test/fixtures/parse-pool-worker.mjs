/**
 * Fixture worker for parse-pool shutdown tests. Not a grammar parser.
 * `VG_POOL_WORKER_MODE` selects crash / hang; otherwise it echoes tasks in
 * payload order so the parent can assert a stable sort.
 */
export default async function run(payload) {
  const mode = process.env.VG_POOL_WORKER_MODE || '';
  if (mode === 'crash') {
    // Uncaught, off the task promise. This is the failure that used to make
    // pool shutdown throw `emitter.removeListener is not a function`.
    setTimeout(() => {
      throw new Error('parse worker crashed');
    }, 20);
    await new Promise(() => {});
  }
  if (mode === 'hang') {
    await new Promise(() => {});
  }
  const tasks = (payload && payload.tasks) || [];
  return tasks.map((task) => ({
    rel: task.rel,
    lang: task.lang,
    hash: 'h',
    bytes: 1,
    defs: [],
    calls: [],
    imports: [],
    heritage: [],
    typeRefs: [],
    guards: [],
  }));
}
