export function ageMs(iso, nowMs = Date.now()) {
  const value = Date.parse(iso || '');
  return Number.isFinite(value) ? nowMs - value : Infinity;
}

export function foreverDbState(source) {
  if (!source?.login_fresh || !source?.realm_fresh) return 'unknown';
  if (source.realm === false) return 'offline';
  if (source.realm === true && source.login === false) return 'degraded';
  if (source.realm === true && source.login === true) return 'online';
  return 'unknown';
}

export function resolveStatus(profile, diagnostics) {
  const { foreverDb, loginTcp, realmTcp, official } = diagnostics;
  const dbState = foreverDbState(foreverDb);
  const directOnline = Boolean(loginTcp?.up && realmTcp?.up);
  const officialVoteIsFresh =
    Number.isFinite(official?.age_ms) &&
    official.age_ms <= profile.thresholds.officialVoteMaxAgeMs;

  const officialState =
    officialVoteIsFresh &&
    (official?.signal === 'online' || official?.signal === 'offline')
      ? official.signal
      : null;

  const evidence = {
    foreverdb: dbState,
    direct_login: loginTcp?.up ? 'positive' : 'inconclusive',
    direct_realm: realmTcp?.up ? 'positive' : 'inconclusive',
    official: official?.signal
      ? officialVoteIsFresh
        ? official.signal
        : `${official.signal}-context-only`
      : 'none',
  };

  if (dbState === 'online') {
    if (officialState === 'offline') {
      return {
        status: 'unknown',
        confidence: 'conflict',
        reason: 'Fresh aggregate status says online while a recent Blizzard post says offline.',
        evidence,
      };
    }
    return {
      status: 'online',
      confidence: directOnline || officialState === 'online' ? 'high' : 'medium',
      reason:
        directOnline || officialState === 'online'
          ? 'Fresh aggregate status is corroborated.'
          : 'Fresh aggregate status says both login and realm services are answering.',
      evidence,
    };
  }

  if (dbState === 'offline') {
    if (realmTcp?.up || officialState === 'online') {
      return {
        status: 'unknown',
        confidence: 'conflict',
        reason: 'A fresh offline reading conflicts with positive evidence.',
        evidence,
      };
    }
    return {
      status: 'offline',
      confidence: officialState === 'offline' ? 'high' : 'medium',
      reason:
        officialState === 'offline'
          ? 'Fresh aggregate outage is corroborated by Blizzard.'
          : 'Fresh aggregate status says the realm game service is not answering.',
      evidence,
    };
  }

  if (dbState === 'degraded') {
    if (directOnline) {
      return {
        status: 'unknown',
        confidence: 'conflict',
        reason: 'Aggregate status reports degraded service while both direct probes answer.',
        evidence,
      };
    }
    return {
      status: 'degraded',
      confidence: 'medium',
      reason: 'Fresh aggregate status says the realm answers but the login service does not.',
      evidence,
    };
  }

  if (directOnline) {
    if (officialState === 'offline') {
      return {
        status: 'unknown',
        confidence: 'conflict',
        reason: 'Direct probes answer while a recent Blizzard post says offline.',
        evidence,
      };
    }
    return {
      status: 'online',
      confidence: 'medium',
      reason: 'Both direct service probes answer while the aggregate sensor is unavailable or stale.',
      evidence,
    };
  }

  if (officialState === 'offline') {
    return {
      status: 'offline',
      confidence: 'medium',
      reason: 'Blizzard recently said the environment is offline while the aggregate sensor is unavailable.',
      evidence,
    };
  }

  if (officialState === 'online' && (loginTcp?.up || realmTcp?.up)) {
    return {
      status: 'online',
      confidence: 'medium',
      reason: 'Blizzard recently said the environment is online and a direct service probe answers.',
      evidence,
    };
  }

  return {
    status: 'unknown',
    confidence: 'insufficient',
    reason: 'Available sources are stale, unavailable, or insufficient to establish realm state.',
    evidence,
  };
}

export function normalizeState(raw, profileId) {
  const state = raw && typeof raw === 'object' ? raw : {};
  const known =
    ['online', 'offline', 'degraded'].includes(state.status)
      ? state.status
      : state.confirmed_status;

  return {
    version: 3,
    profile: state.profile || profileId,
    status: state.status || 'unknown',
    confirmed_status: state.confirmed_status || known || 'unknown',
    updated_at: state.updated_at || null,
    last_health_at: state.last_health_at || null,
    unknown_streak: Number(state.unknown_streak || 0),
  };
}

export function evaluateObservation(profile, previousRaw, observed, nowIso) {
  const previous = normalizeState(previousRaw, profile.id);
  const isBootstrap = !previousRaw || Object.keys(previousRaw).length === 0;

  if (observed.status === 'unknown') {
    const nextStreak = previous.unknown_streak + 1;
    const next = {
      ...previous,
      version: 3,
      profile: profile.id,
      unknown_streak: nextStreak,
      last_health_at: previous.last_health_at || (isBootstrap ? nowIso : null),
    };

    if (
      !isBootstrap &&
      nextStreak >= profile.thresholds.unknownConfirmations &&
      previous.status !== 'unknown'
    ) {
      next.status = 'unknown';
      next.updated_at = nowIso;
      return { previous, next, action: 'transition', bootstrap: false };
    }
    return { previous, next, action: null, bootstrap: isBootstrap };
  }

  const next = {
    ...previous,
    version: 3,
    profile: profile.id,
    status: observed.status,
    confirmed_status: observed.status,
    unknown_streak: 0,
    updated_at:
      previous.status === observed.status && previous.updated_at
        ? previous.updated_at
        : nowIso,
    last_health_at: previous.last_health_at || (isBootstrap ? nowIso : null),
  };

  if (isBootstrap) {
    return { previous, next, action: null, bootstrap: true };
  }

  if (previous.status !== observed.status) {
    return { previous, next, action: 'transition', bootstrap: false };
  }

  const heartbeatDue =
    next.last_health_at &&
    ageMs(next.last_health_at, Date.parse(nowIso)) >=
      profile.thresholds.heartbeatMs;

  if (heartbeatDue) {
    next.last_health_at = nowIso;
    return { previous, next, action: 'heartbeat', bootstrap: false };
  }

  return { previous, next, action: null, bootstrap: false };
}

export function statusLabel(value) {
  if (value === 'online') return 'ONLINE';
  if (value === 'offline') return 'OFFLINE';
  if (value === 'degraded') return 'DEGRADED';
  return 'UNKNOWN';
}
