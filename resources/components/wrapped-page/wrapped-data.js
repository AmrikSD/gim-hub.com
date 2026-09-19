import { skillsInBackendOrder } from "../../api/requests/group-data";
import { mappedGEPrice } from "../../game/items";
import { computeVirtualLevelFromXP } from "../../game/skill";

const DIFFICULTY_ORDER = ["Novice", "Intermediate", "Experienced", "Master", "Grandmaster", "Special"];

const LEVEL_99_XP = 13_034_431;

// Hiscores "activities" that are not boss kill counts.
const NON_BOSS_ACTIVITIES = [
  "League Points",
  "Deadman Points",
  "Bounty Hunter",
  "Clue Scrolls",
  "LMS",
  "PvP Arena",
  "Soul Wars Zeal",
  "Rifts closed",
  "Colosseum Glory",
  "Collections Logged",
];

export function formatXP(xp) {
  return xp.toLocaleString("en-GB");
}

export function formatShortXP(xp) {
  if (xp >= 1_000_000) return `${(xp / 1_000_000).toFixed(1)}M`;
  if (xp >= 1_000) return `${Math.round(xp / 1_000)}K`;
  return `${xp}`;
}

export function formatDay(dayKey) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
}

export function sumExperience(sample) {
  return sample.data.reduce(function addExperience(sum, experience) {
    return sum + experience;
  }, 0);
}

function realLevelFromXP(xp) {
  return Math.min(99, computeVirtualLevelFromXP(xp));
}

// Day buckets use the viewer's local calendar so they line up with the
// local-time hour histogram.
function localDayKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Merge several fetchSkillData responses into one sorted, deduplicated series per member. */
export function mergeSkillDataResponses(responses) {
  const merged = new Map();

  for (const response of responses) {
    for (const [member, samples] of response.members) {
      const existing = merged.get(member) ?? new Map();
      for (const sample of samples) {
        existing.set(sample.time.getTime(), sample);
      }
      merged.set(member, existing);
    }
  }

  return new Map(
    [...merged].map(function sortMemberSamples([member, samplesByTime]) {
      const samples = [...samplesByTime.values()].sort(function byTime(first, second) {
        return first.time - second.time;
      });
      return [member, samples];
    }),
  );
}

export function computeMemberStats({ memberSamples, collectionLogs, bossKcByMember, yearStart }) {
  const stats = [];

  for (const [member, samples] of memberSamples) {
    if (samples.length === 0) continue;

    const baseline = samples.findLast((sample) => sample.time <= yearStart) ?? samples[0];
    const latest = samples[samples.length - 1];
    const baselineTotal = sumExperience(baseline);

    const gainedPerSkill = skillsInBackendOrder.map(function skillGain(skill, index) {
      const startXP = baseline.data[index] ?? 0;
      const endXP = latest.data[index] ?? 0;
      return {
        skill,
        xp: Math.max(0, endXP - startXP),
        levels: realLevelFromXP(endXP) - realLevelFromXP(startXP),
        reached99: startXP < LEVEL_99_XP && endXP >= LEVEL_99_XP,
      };
    });

    const dayTotals = new Map();
    const hourTotals = new Array(24).fill(0);
    let unattributedXP = 0;
    let previous = baseline;
    for (const sample of samples) {
      if (sample.time <= previous.time) continue;
      const delta = Math.max(0, sumExperience(sample) - sumExperience(previous));
      if (delta > 0) {
        // The XP was earned somewhere in the half-open interval
        // (previous.time, sample.time]. Only book it to a day (or hour) the
        // whole interval provably lies in; boundary-aligned samples (e.g.
        // midnight or on-the-hour) belong to the bucket they close, hence
        // the millisecond nudges. Everything else stays in the totals but
        // is reported as unattributed.
        const intervalStart = new Date(previous.time.getTime() + 1);
        const intervalEnd = new Date(sample.time.getTime() - 1);
        if (localDayKey(intervalStart) === localDayKey(intervalEnd)) {
          const day = localDayKey(intervalEnd);
          dayTotals.set(day, (dayTotals.get(day) ?? 0) + delta);
          if (intervalStart.getHours() === intervalEnd.getHours()) {
            hourTotals[intervalEnd.getHours()] += delta;
          }
        } else {
          unattributedXP += delta;
        }
      }
      previous = sample;
    }

    let biggestDay;
    for (const [day, xp] of dayTotals) {
      if (!biggestDay || xp > biggestDay.xp) {
        biggestDay = { day, xp };
      }
    }

    const activeDays = [...dayTotals.keys()].sort();
    let longestStreak = 0;
    let streak = 0;
    let previousDay;
    for (const day of activeDays) {
      let expected;
      if (previousDay) {
        const [year, month, dayOfMonth] = previousDay.split("-").map(Number);
        expected = localDayKey(new Date(year, month - 1, dayOfMonth + 1));
      }
      streak = day === expected ? streak + 1 : 1;
      longestStreak = Math.max(longestStreak, streak);
      previousDay = day;
    }

    stats.push({
      member,
      xpGained: Math.max(0, sumExperience(latest) - baselineTotal),
      unattributedXP,
      topSkills: [...gainedPerSkill].sort((first, second) => second.xp - first.xp).slice(0, 3),
      levelsGained: gainedPerSkill.reduce((sum, entry) => sum + entry.levels, 0),
      new99s: gainedPerSkill.filter((entry) => entry.reached99).map((entry) => entry.skill),
      totalLevel: skillsInBackendOrder.reduce(
        (sum, _skill, index) => sum + realLevelFromXP(latest.data[index] ?? 0),
        0,
      ),
      biggestDay,
      activeDays,
      xpBySkill: Object.fromEntries(gainedPerSkill.map((entry) => [entry.skill, entry.xp])),
      activeDayCount: activeDays.length,
      skillsTrained: gainedPerSkill.filter((entry) => entry.xp > 0).length,
      longestStreak,
      hourTotals,
      collectionSlots: collectionLogs.get(member)?.size ?? 0,
      topBosses: [...(bossKcByMember.get(member) ?? new Map())]
        .filter(function isBossActivity([activity, killCount]) {
          return killCount > 0 && !NON_BOSS_ACTIVITIES.some((prefix) => activity.startsWith(prefix));
        })
        .sort((first, second) => second[1] - first[1])
        .slice(0, 3),
    });
  }

  // Neutral ordering: it's a group, not a leaderboard. The race slide is the
  // one place members are deliberately ranked.
  return stats.sort((first, second) => first.member.localeCompare(second.member));
}

// Activity inference for the specialist award: the XP distribution hints at
// WHAT they were actually doing, so the title matches the activity instead of
// a generic "Specialist". All heuristics, worn proudly.
const MELEE_SKILLS = ["Attack", "Strength", "Defence"];
const COMBAT_SKILLS = [...MELEE_SKILLS, "Ranged", "Magic", "Hitpoints"];
// Slayer XP accrues at roughly 1/5 the rate of the combat XP it accompanies;
// a ratio near that means the combat happened on-task.
const ON_TASK_SLAYER_RATIO = 0.12;

const NONCOMBAT_SPECIALIST_AWARDS = {
  Construction: ["The Homeowner", "the butler took most of the money"],
  Cooking: ["The Head Chef", "allegedly never burnt a single shark"],
  Fishing: ["The Angler", "the barbarians taught them well"],
  Firemaking: ["The Pyromaniac", "Wintertodt's most loyal customer"],
  Woodcutting: ["The Lumberjack", "the trees still whisper their name"],
  Farming: ["The Groundskeeper", "life is just tree runs between logouts"],
  Agility: ["The Roof Runner", "laps until the marks stopped mattering"],
  Thieving: ["The Pickpocket", "the Ardougne knights never noticed a thing"],
  Mining: ["The Prospector", "Motherlode Mine season ticket holder"],
  Smithing: ["The Blacksmith", "on a first-name basis with the blast furnace"],
  Crafting: ["The Glassblower", "the glassblowing pipe never rests"],
  Fletching: ["The Dart Magnate", "a dart-tip empire, one click at a time"],
  Herblore: ["The Potioneer", "gp goes in, potions come out"],
  Runecraft: ["The Rift Guardian", "a Guardians of the Rift regular"],
  Prayer: ["The Bone Collector", "burying gp one bone at a time"],
  Hunter: ["The Birdhouse Baron", "birdhouses checked with military discipline"],
  Sailing: ["The Sea Dog", "set sail and never looked back"],
};

function specialistAward(member) {
  const xp = member.xpBySkill ?? {};
  const total = Math.max(1, member.xpGained);
  const top = member.topSkills[0];
  const share = Math.round((top.xp / total) * 100);

  const combatXP = COMBAT_SKILLS.reduce((sum, skill) => sum + (xp[skill] ?? 0), 0);
  const combatShare = Math.round((combatXP / total) * 100);
  const onTask = combatXP > 0 && (xp.Slayer ?? 0) / combatXP >= ON_TASK_SLAYER_RATIO;

  if (combatXP / total >= 0.5) {
    if (onTask) {
      return {
        title: "The Taskmaster",
        detail: `${combatShare}% combat XP with the Slayer points to prove it — whatever Duradel says, goes`,
      };
    }
    const meleeXP = MELEE_SKILLS.reduce((sum, skill) => sum + (xp[skill] ?? 0), 0);
    if ((xp.Magic ?? 0) > combatXP * 0.6 && (xp.Hitpoints ?? 0) < combatXP * 0.05) {
      return {
        title: "The Plank Magnate",
        detail: `${share}% Magic without taking a scratch — definitely just plank make on repeat`,
      };
    }
    if ((xp.Ranged ?? 0) > meleeXP) {
      return {
        title: "The Cannoneer",
        detail: `${combatShare}% combat XP, light on Slayer — a cannonball budget with no equal`,
      };
    }
    return {
      title: "The Crab Whisperer",
      detail: `${combatShare}% melee and barely a Slayer point — the gemstone crabs have families, you know`,
    };
  }

  const themed = NONCOMBAT_SPECIALIST_AWARDS[top.skill];
  if (themed) {
    return { title: themed[0], detail: `${share}% of their XP went into ${top.skill} — ${themed[1]}` };
  }
  return { title: "The Specialist", detail: `${share}% of their XP went into ${top.skill}` };
}

/**
 * Give every member a unique positive superlative, so the spotlight slides
 * celebrate something for everyone regardless of playtime. Candidates are
 * tried in priority order; each is awarded to its strongest unassigned
 * member; a fallback guarantees nobody goes without.
 */
export function assignSuperlatives(memberStats, daysSoFar = 0) {
  const candidates = [
    {
      title: "The Marathoner",
      score: (member) => member.longestStreak,
      detail: (member) => `a ${member.longestStreak}-day streak without missing a day`,
    },
    {
      title: "The Specialist",
      score: (member) => {
        if (!(member.xpGained > 0) || !member.topSkills?.[0]) return 0;
        const combatXP = COMBAT_SKILLS.reduce((sum, skill) => sum + (member.xpBySkill?.[skill] ?? 0), 0);
        return Math.max(member.topSkills[0].xp, combatXP) / member.xpGained;
      },
      resolve: specialistAward,
    },
    {
      title: "The All-Rounder",
      score: (member) => member.skillsTrained ?? 0,
      detail: (member) => `trained ${member.skillsTrained} different skills this year`,
    },
    {
      title: "The Collector",
      score: (member) => member.collectionSlots,
      detail: (member) => `${member.collectionSlots} collection log slots and counting`,
    },
    {
      title: "The Boss Slayer",
      score: (member) => (member.topBosses ?? []).reduce((sum, [, killCount]) => sum + killCount, 0),
      detail: (member) => `${member.topBosses[0][0]} fears them most`,
    },
    {
      title: "The Big Hitter",
      score: (member) => member.biggestDay?.xp ?? 0,
      detail: (member) => `${formatShortXP(member.biggestDay.xp)} XP in a single day`,
    },
    // Low-priority time-of-day awards: mildly interesting, so they only land
    // when nothing better fits.
    {
      title: "The Night Owl",
      score: (member) => {
        const peak = peakHour(member.hourTotals);
        return peak !== undefined && (peak >= 22 || peak <= 4) ? member.hourTotals[peak] : 0;
      },
      detail: (member) => `busiest after dark — peak hour ${String(peakHour(member.hourTotals)).padStart(2, "0")}:00`,
    },
    {
      title: "The Early Bird",
      score: (member) => {
        const peak = peakHour(member.hourTotals);
        return peak !== undefined && peak >= 5 && peak <= 11 ? member.hourTotals[peak] : 0;
      },
      detail: (member) => `up and skilling — peak hour ${String(peakHour(member.hourTotals)).padStart(2, "0")}:00`,
    },
    // Joke award, deliberately last in priority: real achievements assign
    // first, so this lands affectionately on whoever played least.
    {
      title: "The Grass Toucher",
      score: (member) => Math.max(0, daysSoFar - member.activeDayCount),
      detail: (member) => `touched grass ${daysSoFar - member.activeDayCount} days this year — healthiest in the group`,
    },
  ];

  const assigned = new Map();
  for (const candidate of candidates) {
    let best;
    for (const member of memberStats) {
      if (assigned.has(member.member)) continue;
      const score = candidate.score(member);
      if (score > 0 && (!best || score > best.score)) {
        best = { member, score };
      }
    }
    if (best) {
      const award = candidate.resolve
        ? candidate.resolve(best.member)
        : { title: candidate.title, detail: candidate.detail(best.member) };
      assigned.set(best.member.member, award);
    }
  }

  for (const member of memberStats) {
    if (!assigned.has(member.member)) {
      assigned.set(member.member, { title: "The Ironman", detail: "in it for the long haul" });
    }
  }

  return assigned;
}

function peakHour(hourTotals) {
  if (!hourTotals) return undefined;
  const max = Math.max(...hourTotals);
  return max > 0 ? hourTotals.indexOf(max) : undefined;
}

/**
 * The team's collective grass report: days this year on which NOBODY had
 * tracked XP, plus the quietest and busiest complete months by team-active
 * days. Group-level by design — one shared laugh instead of a comparison.
 */
export function computeTeamRest(memberStats, { year, daysSoFar, currentMonth }) {
  if (memberStats.length === 0 || daysSoFar <= 0) {
    return undefined;
  }

  const teamActiveDays = new Set();
  for (const member of memberStats) {
    for (const day of member.activeDays ?? []) {
      teamActiveDays.add(day);
    }
  }

  const activeDaysPerMonth = new Array(12).fill(0);
  for (const day of teamActiveDays) {
    const [dayYear, month] = day.split("-").map(Number);
    if (dayYear === year) {
      activeDaysPerMonth[month - 1] += 1;
    }
  }

  // Quietest considers only complete months, so a two-day-old month can't
  // win by default. Busiest may include the current month — being busy in a
  // partial month is still busy (and for a group whose whole year happened
  // recently, it's the only honest answer).
  let quietestMonth;
  let busiestMonth;
  for (let month = 0; month <= currentMonth; month += 1) {
    const active = activeDaysPerMonth[month];
    if (month < currentMonth && (!quietestMonth || active < quietestMonth.activeDays)) {
      quietestMonth = { month, activeDays: active };
    }
    if (!busiestMonth || active > busiestMonth.activeDays) {
      busiestMonth = { month, activeDays: active };
    }
  }

  // No contrast, no punchline: drop the busiest clause when nobody was ever
  // busy or when it would name the same month as the quietest.
  if (busiestMonth && (busiestMonth.activeDays === 0 || busiestMonth.month === quietestMonth?.month)) {
    busiestMonth = undefined;
  }

  const monthName = (entry) =>
    entry === undefined ? undefined : new Date(year, entry.month, 1).toLocaleDateString("en-GB", { month: "long" });

  return {
    grassDays: Math.max(0, daysSoFar - teamActiveDays.size),
    daysSoFar,
    quietestMonth: monthName(quietestMonth),
    quietestMonthActiveDays: quietestMonth?.activeDays,
    busiestMonth: monthName(busiestMonth),
  };
}

/**
 * Time series for the animated race: cumulative XP gained per member sampled
 * at `steps` evenly spaced instants across the year, plus a drama-weighted
 * progress mapping so playback lingers where XP was actually earned and
 * skims the flat months (20% of runtime spread evenly, 80% proportional to
 * the group's XP gained in each step).
 */
export function computeRaceSeries({ memberSamples, yearStart, steps = 240, endTime = Date.now() }) {
  const start = yearStart.getTime();
  if (endTime <= start) {
    return undefined;
  }

  const times = Array.from({ length: steps + 1 }, (_, index) => start + ((endTime - start) * index) / steps);
  const members = [];
  for (const [member, samples] of memberSamples) {
    if (samples.length === 0) continue;
    const baseline = samples.findLast((sample) => sample.time <= yearStart) ?? samples[0];
    const baselineTotal = sumExperience(baseline);
    let sampleIndex = 0;
    let lastValue = 0;
    const values = times.map(function valueAt(time) {
      while (sampleIndex < samples.length && samples[sampleIndex].time.getTime() <= time) {
        sampleIndex += 1;
      }
      const sample = sampleIndex > 0 ? samples[sampleIndex - 1] : baseline;
      lastValue = Math.max(lastValue, Math.max(0, sumExperience(sample) - baselineTotal));
      return lastValue;
    });
    members.push({ member, values });
  }
  if (members.length === 0) {
    return undefined;
  }

  const stepDeltas = times.map(function groupDelta(_, index) {
    if (index === 0) return 0;
    return members.reduce((sum, member) => sum + (member.values[index] - member.values[index - 1]), 0);
  });
  const totalDelta = stepDeltas.reduce((sum, delta) => sum + delta, 0);
  const progressAt = [0];
  for (let index = 1; index < times.length; index += 1) {
    const even = 1 / (times.length - 1);
    const weight = totalDelta > 0 ? 0.2 * even + 0.8 * (stepDeltas[index] / totalDelta) : even;
    progressAt.push(progressAt[index - 1] + weight);
  }
  const total = progressAt[progressAt.length - 1];
  for (let index = 0; index < progressAt.length; index += 1) {
    progressAt[index] /= total;
  }

  return { times, members, progressAt };
}

/**
 * Quest standing from a parsed member's status array (positionally aligned
 * with the sorted quest ids in the quest game data). Current state only —
 * the backend keeps no quest history.
 */
export function computeQuestStats(questStatuses, questData) {
  if (!questStatuses || !questData?.size) {
    return undefined;
  }

  const questIds = [...questData.keys()];
  let completed = 0;
  let points = 0;
  let possiblePoints = 0;
  let hardest;

  questIds.forEach(function tallyQuest(questId, index) {
    const quest = questData.get(questId);
    possiblePoints += quest.points ?? 0;

    if (questStatuses[index] !== "FINISHED") {
      return;
    }

    completed += 1;
    points += quest.points ?? 0;

    const rank = DIFFICULTY_ORDER.indexOf(quest.difficulty);
    if (!quest.miniquest && (!hardest || rank > hardest.rank)) {
      hardest = { name: quest.name, difficulty: quest.difficulty, rank };
    }
  });

  return { completed, total: questData.size, points, possiblePoints, hardest };
}

/**
 * Diary standing from a parsed member's diaries object
 * (region -> tier -> boolean[] task completion). Current state only.
 */
export function computeDiaryStats(diaries) {
  if (!diaries) {
    return undefined;
  }

  let tiersComplete = 0;
  let tiersTotal = 0;
  let tasksComplete = 0;
  let tasksTotal = 0;

  for (const tiers of Object.values(diaries)) {
    for (const tasks of Object.values(tiers)) {
      tiersTotal += 1;
      tasksTotal += tasks.length;
      const done = tasks.filter(Boolean).length;
      tasksComplete += done;
      if (tasks.length > 0 && done === tasks.length) {
        tiersComplete += 1;
      }
    }
  }

  return { tiersComplete, tiersTotal, tasksComplete, tasksTotal };
}

// Milestone untradeables, most impressive first. ALWAYS entries are shown
// whenever owned (for-sure-for-sure impressive); FALLBACK entries only stand
// in when a member's log has no drop worth showing. At most ONE milestone
// ever appears per member. Extend either list; things like the Rune defender
// belong on neither.
const ALWAYS_MILESTONES = ["infernal cape", "avernic defender", "fire cape"];
const FALLBACK_MILESTONES = ["dragon defender", "barrows gloves"];
// A member "has drops worth showing" when their best is at least this.
const FALLBACK_DROP_FLOOR = 50_000;
const PET_PRESTIGE = 500_000_000;
const GEAR_CONTAINERS = ["bank", "equipment", "inventory"];

function petTagBitmask(itemTags) {
  if (!itemTags?.tags) return 0n;
  let bitmask = 0n;
  for (const [tag, bitIndex] of itemTags.tags) {
    if (tag === "pets") {
      bitmask |= 1n << BigInt(bitIndex);
    }
  }
  return bitmask;
}

function* ownedItemStacks(profile) {
  for (const container of GEAR_CONTAINERS) {
    const stacks = profile?.[container];
    if (stacks instanceof Map) {
      yield* stacks.values();
    }
  }
}

function memberOwnsItem(itemID, memberName, collectionLogs, memberProfiles) {
  if ((collectionLogs?.get(memberName)?.get(itemID) ?? 0) > 0) {
    return true;
  }
  for (const stack of ownedItemStacks(memberProfiles?.get(memberName))) {
    if (stack.itemID === itemID && stack.quantity > 0) {
      return true;
    }
  }
  return false;
}

function findMilestone({ member, collectionLogs, memberProfiles, items, bestDropScore }) {
  const lists = [ALWAYS_MILESTONES];
  if (bestDropScore < FALLBACK_DROP_FLOOR) {
    lists.push(FALLBACK_MILESTONES);
  }

  for (const [listIndex, list] of lists.entries()) {
    for (const milestoneName of list) {
      for (const [itemID, itemDatum] of items) {
        if (itemDatum.name.toLocaleLowerCase() !== milestoneName) continue;
        if (memberOwnsItem(itemID, member, collectionLogs, memberProfiles)) {
          return { itemID, quantity: 1, name: itemDatum.name, category: "milestone", fallback: listIndex === 1 };
        }
      }
    }
  }
  return undefined;
}

/**
 * A member's most notable finds: collection log drops ranked by GE price
 * (pets on top), plus at most ONE curated milestone untradeable — appended
 * only when it's unambiguously impressive (ALWAYS list) or when the member
 * has no drop worth showing (FALLBACK list, placed first as the stand-in).
 * Milestones are detected in the collection log AND bank/equipment/inventory,
 * so a never-scanned log doesn't hide a worn Dragon defender.
 * `unique` marks items nobody else in the group has, checked across both
 * sources.
 */
export function computeTopFinds({ member, collectionLogs, memberProfiles, items, gePrices, itemTags, limit = 3 }) {
  if (!items?.size) {
    return [];
  }
  const petBits = petTagBitmask(itemTags);

  const drops = [];
  for (const [itemID, quantity] of collectionLogs.get(member) ?? []) {
    if (quantity <= 0) continue;
    const isPet = petBits !== 0n && (BigInt(itemTags?.items?.[itemID] ?? 0) & petBits) !== 0n;
    const gePrice = mappedGEPrice(itemID, gePrices, items);
    drops.push({
      itemID,
      quantity,
      name: items.get(itemID)?.name ?? `Item #${itemID}`,
      category: isPet ? "pet" : "drop",
      score: isPet ? PET_PRESTIGE : gePrice,
      gePrice,
    });
  }
  drops.sort((first, second) => second.score - first.score);

  const milestone = findMilestone({
    member,
    collectionLogs,
    memberProfiles,
    items,
    bestDropScore: drops[0]?.score ?? 0,
  });

  const picked = drops.slice(0, milestone ? limit - 1 : limit);
  if (milestone) {
    // A fallback milestone is the stand-in headline; an earned elite one
    // rounds out the list without displacing real drops from the top.
    if (milestone.fallback) {
      picked.unshift(milestone);
    } else {
      picked.push(milestone);
    }
  }

  return picked.map(function finishFind(candidate) {
    let unique = true;
    for (const otherMember of new Set([...collectionLogs.keys(), ...(memberProfiles?.keys() ?? [])])) {
      if (otherMember !== member && otherMember !== "@SHARED") {
        if (memberOwnsItem(candidate.itemID, otherMember, collectionLogs, memberProfiles)) {
          unique = false;
          break;
        }
      }
    }
    return {
      itemID: candidate.itemID,
      quantity: candidate.quantity,
      name: candidate.name,
      category: candidate.category,
      gePrice: candidate.category === "drop" ? candidate.gePrice : 0,
      unique,
    };
  });
}

export function computeGroupStats(memberStats) {
  const hourTotals = new Array(24).fill(0);
  for (const member of memberStats) {
    member.hourTotals.forEach(function addHour(xp, hour) {
      hourTotals[hour] += xp;
    });
  }
  const peakHourXP = Math.max(...hourTotals);

  return {
    xpGained: memberStats.reduce((sum, member) => sum + member.xpGained, 0),
    levelsGained: memberStats.reduce((sum, member) => sum + member.levelsGained, 0),
    collectionSlots: memberStats.reduce((sum, member) => sum + member.collectionSlots, 0),
    hourTotals,
    peakHour: peakHourXP > 0 ? hourTotals.indexOf(peakHourXP) : undefined,
    peakHourXP,
  };
}
