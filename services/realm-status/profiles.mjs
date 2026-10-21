const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const PROFILES = {
  beta: {
    id: 'beta',
    displayName: 'Forever Beta',
    discordChannel: '#beta-realm-status',
    foreverDb: {
      url: 'https://foreverdb.net/status',
      loginLabel: 'Beta login server',
      realmLabel: 'Realm game servers',
      maintenanceLabel: 'Maintenance now:',
    },
    direct: {
      login: { host: 'test.actual.battle.net', port: 1119 },
      realm: { host: '66.40.176.157', port: 3724 },
    },
    forum: {
      trackerUrl:
        'https://us.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json',
      baseUrl: 'https://us.forums.blizzard.com/en/wow',
      categoryId: 349,
      subjectPattern: '(beta|realm(?:s)?)',
    },
    thresholds: {
      foreverDbMaxAgeMs: 10 * MINUTE,
      officialContextMaxAgeMs: 6 * HOUR,
      officialVoteMaxAgeMs: 90 * MINUTE,
      heartbeatMs: 24 * HOUR,
      unknownConfirmations: 2,
    },
  },
};

export function getProfile(name = 'beta') {
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(
      `Unknown Forever environment profile "${name}". Available profiles: ${Object.keys(PROFILES).join(', ')}`,
    );
  }
  return profile;
}

export function listProfiles() {
  return Object.keys(PROFILES);
}
