type VoiceSessionModule = typeof import('@plumbus/voice/session');

const defaultImports = {
  session: () => import('@plumbus/voice/session'),
  root: () => import('@plumbus/voice'),
};

/**
 * Loads `@plumbus/voice/session` (voice 0.6.1+), or the `@plumbus/voice` root when the
 * installed voice predates that entry. Core 0.8.3 may sit next to voice 0.6.0, whose
 * root exports the same runtime functions. Exits with an install hint when voice is absent.
 */
export async function loadVoiceSession(
  imports: { session(): Promise<unknown>; root(): Promise<unknown> } = defaultImports,
): Promise<VoiceSessionModule> {
  try {
    return (await imports.session()) as VoiceSessionModule;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      return (await imports.root()) as VoiceSessionModule;
    }
    console.error('');
    console.error('Voice runtime not installed.');
    console.error('Run: pnpm add @plumbus/voice');
    console.error('');
    process.exit(1);
  }
}
