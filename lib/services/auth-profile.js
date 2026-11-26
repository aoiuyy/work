/**
 * Resolves stored GitHub credentials and persistent workstation profile.
 */
export function createAuthProfileService({ cfg, vault, stableMachineId }) {
  async function getStoredGithubAuth() {
    if (process.platform !== 'win32') {
      if (process.env.GITHUB_USERNAME && process.env.GITHUB_TOKEN) {
        return { username: process.env.GITHUB_USERNAME, token: process.env.GITHUB_TOKEN };
      }
      return null;
    }
    try {
      return await vault.readGithubAuth();
    } catch {
      return null;
    }
  }

  async function ensureMachineProfile() {
    const machineId = stableMachineId();
    let profile = await vault.readMachineProfile().catch(() => null);
    if (!profile || !profile.machineToken) {
      const hexTail = machineId.slice(0, 8).toUpperCase();
      const randomTail = Math.random().toString(36).substring(2, 6).toUpperCase();
      profile = {
        machineId,
        machineName: cfg.machineName,
        machineToken: `WK-${hexTail.slice(0, 4)}-${randomTail}`,
      };
      await vault.writeMachineProfile(profile).catch(() => {});
    }
    return profile;
  }

  return { getStoredGithubAuth, ensureMachineProfile };
}
