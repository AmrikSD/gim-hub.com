import { describe, expect, it } from "vite-plus/test";
import { skillsInBackendOrder } from "../../api/requests/group-data";
import {
  assignSuperlatives,
  computeDiaryStats,
  computeGroupStats,
  computeMemberStats,
  computeQuestStats,
  computeRaceSeries,
  computeTeamRest,
  computeTopFinds,
  mergeSkillDataResponses,
  sumExperience,
} from "../../components/wrapped-page/wrapped-data";

const YEAR_START = new Date(Date.UTC(2026, 0, 1));
const ATTACK = skillsInBackendOrder.indexOf("Attack");
const FISHING = skillsInBackendOrder.indexOf("Fishing");

function sample(time, skillXP = {}) {
  const data = new Array(skillsInBackendOrder.length).fill(0);
  for (const [index, xp] of Object.entries(skillXP)) {
    data[index] = xp;
  }
  return { time, data };
}

function statsFor(samples, overrides = {}) {
  return computeMemberStats({
    memberSamples: new Map([["Wise Old Man", samples]]),
    collectionLogs: overrides.collectionLogs ?? new Map(),
    bossKcByMember: overrides.bossKcByMember ?? new Map(),
    yearStart: YEAR_START,
  })[0];
}

describe("mergeSkillDataResponses", function describeMerge() {
  it("deduplicates overlapping samples and sorts by time", function testMerge() {
    const early = sample(new Date("2026-02-01T12:00:00Z"), { [ATTACK]: 100 });
    const duplicate = sample(new Date("2026-02-01T12:00:00Z"), { [ATTACK]: 100 });
    const late = sample(new Date("2026-03-01T12:00:00Z"), { [ATTACK]: 200 });

    const merged = mergeSkillDataResponses([
      { members: new Map([["Wise Old Man", [late, early]]]) },
      { members: new Map([["Wise Old Man", [duplicate]]]) },
    ]);

    expect(merged.get("Wise Old Man")).toHaveLength(2);
    expect(merged.get("Wise Old Man")[0].time).toEqual(early.time);
    expect(merged.get("Wise Old Man")[1].time).toEqual(late.time);
  });
});

describe("computeMemberStats", function describeMemberStats() {
  it("measures gains from the last sample at or before the year start", function testBaseline() {
    const stats = statsFor([
      sample(new Date("2025-12-01T00:00:00Z"), { [ATTACK]: 500 }),
      sample(new Date("2025-12-20T00:00:00Z"), { [ATTACK]: 1_000 }),
      sample(new Date("2026-05-01T12:00:00Z"), { [ATTACK]: 6_000 }),
    ]);

    expect(stats.xpGained).toBe(5_000);
    expect(stats.topSkills[0]).toMatchObject({ skill: "Attack", xp: 5_000 });
  });

  it("uses the first sample as baseline for members first seen mid-year", function testMidYearBaseline() {
    const stats = statsFor([
      sample(new Date("2026-06-01T12:00:00Z"), { [ATTACK]: 9_000 }),
      sample(new Date("2026-06-02T12:00:00Z"), { [ATTACK]: 10_000 }),
    ]);

    expect(stats.xpGained).toBe(1_000);
  });

  it("books XP only to days the whole interval provably lies in", function testGapAttribution() {
    // Local-time dates: day/hour buckets use the viewer's local calendar.
    const stats = statsFor([
      sample(new Date(2026, 0, 1, 12, 0), { [ATTACK]: 0 }),
      // 40h gap spanning days: unattributable.
      sample(new Date(2026, 0, 3, 4, 0), { [ATTACK]: 700 }),
      // 30min gap within one hour of one day: fully attributable.
      sample(new Date(2026, 0, 3, 4, 30), { [ATTACK]: 1_000 }),
    ]);

    expect(stats.xpGained).toBe(1_000);
    expect(stats.unattributedXP).toBe(700);
    expect(stats.biggestDay).toEqual({ day: "2026-01-03", xp: 300 });
    expect(stats.activeDayCount).toBe(1);
    expect(stats.hourTotals.reduce((sum, xp) => sum + xp, 0)).toBe(300);
    expect(stats.hourTotals[4]).toBe(300);
  });

  it("credits boundary-aligned samples to the bucket they close", function testBoundaryAttribution() {
    const stats = statsFor([
      sample(new Date(2026, 0, 1, 23, 0), { [ATTACK]: 0 }),
      // Midnight-aligned sample: the XP was earned during Jan 1's hour 23,
      // not on Jan 2.
      sample(new Date(2026, 0, 2, 0, 0), { [ATTACK]: 500 }),
    ]);

    expect(stats.biggestDay).toEqual({ day: "2026-01-01", xp: 500 });
    expect(stats.hourTotals[23]).toBe(500);
  });

  it("keeps multi-hour same-day gains out of the hour histogram", function testHourGranularity() {
    const stats = statsFor([
      sample(new Date(2026, 0, 5, 2, 0), { [FISHING]: 0 }),
      // 10h gap: pinned to the day, too coarse for an hour.
      sample(new Date(2026, 0, 5, 12, 0), { [FISHING]: 400 }),
    ]);

    expect(stats.biggestDay).toEqual({ day: "2026-01-05", xp: 400 });
    expect(stats.hourTotals.every((xp) => xp === 0)).toBe(true);
  });

  it("computes levels gained and new 99s", function testLevels() {
    const stats = statsFor([
      // 12,031,223 XP = level 98; 13,034,431 = level 99.
      sample(new Date("2025-12-31T00:00:00Z"), { [ATTACK]: 12_031_223, [FISHING]: 0 }),
      sample(new Date("2026-07-01T12:00:00Z"), { [ATTACK]: 13_034_431, [FISHING]: 83 }),
    ]);

    // Attack 98 -> 99, Fishing 1 -> 2.
    expect(stats.levelsGained).toBe(2);
    expect(stats.new99s).toEqual(["Attack"]);
    // 22 untrained skills at level 1, Attack 99, Fishing 2.
    expect(stats.totalLevel).toBe(22 + 99 + 2);
  });

  it("finds the longest streak of consecutive active days", function testStreak() {
    const days = [1, 2, 3, 10];
    const samples = [sample(new Date(2026, 0, 1, 12, 0), { [ATTACK]: 0 })];
    days.forEach(function addDay(day, index) {
      samples.push(sample(new Date(2026, 2, day, 12, 0), { [ATTACK]: (index + 1) * 100 }));
      samples.push(sample(new Date(2026, 2, day, 13, 0), { [ATTACK]: (index + 1) * 100 + 50 }));
    });

    const stats = statsFor(samples);

    expect(stats.activeDayCount).toBe(4);
    expect(stats.longestStreak).toBe(3);
  });

  it("filters non-boss activities out of the top bosses", function testBossFilter() {
    const stats = statsFor(
      [sample(new Date("2026-01-01T00:00:00Z"), {}), sample(new Date("2026-06-01T00:00:00Z"), {})],
      {
        bossKcByMember: new Map([
          [
            "Wise Old Man",
            new Map([
              ["Clue Scrolls (all)", 500],
              ["Collections Logged", 200],
              ["Zulrah", 150],
              ["Vorkath", 90],
              ["Kraken", 0],
            ]),
          ],
        ]),
      },
    );

    expect(stats.topBosses).toEqual([
      ["Zulrah", 150],
      ["Vorkath", 90],
    ]);
  });

  it("sorts members neutrally by name, not by XP", function testSorting() {
    const stats = computeMemberStats({
      memberSamples: new Map([
        [
          "Bronzeman",
          [
            sample(new Date("2026-01-01T00:00:00Z"), { [ATTACK]: 0 }),
            sample(new Date("2026-02-01T00:00:00Z"), { [ATTACK]: 10 }),
          ],
        ],
        [
          "Gnome Child",
          [
            sample(new Date("2026-01-01T00:00:00Z"), { [ATTACK]: 0 }),
            sample(new Date("2026-02-01T00:00:00Z"), { [ATTACK]: 999 }),
          ],
        ],
      ]),
      collectionLogs: new Map(),
      bossKcByMember: new Map(),
      yearStart: YEAR_START,
    });

    expect(stats.map((member) => member.member)).toEqual(["Bronzeman", "Gnome Child"]);
  });
});

describe("assignSuperlatives", function describeSuperlatives() {
  function makeMember(name, overrides = {}) {
    return {
      member: name,
      xpGained: 0,
      hourTotals: new Array(24).fill(0),
      longestStreak: 0,
      activeDayCount: 0,
      skillsTrained: 0,
      collectionSlots: 0,
      topSkills: [],
      topBosses: [],
      biggestDay: undefined,
      ...overrides,
    };
  }

  it("gives every member a unique award, joke award last", function testSuperlatives() {
    const nightOwl = makeMember("A", { hourTotals: [0, 500, ...new Array(22).fill(0)], activeDayCount: 100 });
    const marathoner = makeMember("B", { longestStreak: 20, activeDayCount: 120 });
    const casual = makeMember("C", { activeDayCount: 5, longestStreak: 1 });

    const awards = assignSuperlatives([nightOwl, marathoner, casual], 260);

    expect(awards.size).toBe(3);
    expect(awards.get("A").title).toBe("The Night Owl");
    expect(awards.get("B").title).toBe("The Marathoner");
    expect(awards.get("C").title).toBe("The Grass Toucher");
    expect(awards.get("C").detail).toContain("255 days");
    expect(new Set([...awards.values()].map((award) => award.title)).size).toBe(3);
  });

  it("titles a melee grinder with no Slayer as the crab enjoyer", function testCrabHeuristic() {
    const crabber = makeMember("C", {
      xpGained: 1_000_000,
      topSkills: [{ skill: "Strength", xp: 500_000, levels: 8 }],
      xpBySkill: { Strength: 500_000, Hitpoints: 165_000, Defence: 100_000, Slayer: 2_000 },
    });

    const awards = assignSuperlatives([crabber], 100);

    expect(awards.get("C").title).toBe("The Crab Whisperer");
    expect(awards.get("C").detail).toContain("gemstone crabs");
  });

  it("recognizes on-task combat as slayer", function testSlayerHeuristic() {
    const slayer = makeMember("T", {
      xpGained: 1_000_000,
      topSkills: [{ skill: "Strength", xp: 400_000, levels: 6 }],
      xpBySkill: { Strength: 400_000, Attack: 150_000, Hitpoints: 180_000, Slayer: 150_000 },
    });

    const awards = assignSuperlatives([slayer], 100);

    expect(awards.get("T").title).toBe("The Taskmaster");
  });

  it("themes a dominant non-combat skill", function testNonCombatTheme() {
    const builder = makeMember("B", {
      xpGained: 1_000_000,
      topSkills: [{ skill: "Construction", xp: 700_000, levels: 20 }],
      xpBySkill: { Construction: 700_000, Magic: 100_000 },
    });

    const awards = assignSuperlatives([builder], 100);

    expect(awards.get("B").title).toBe("The Homeowner");
    expect(awards.get("B").detail).toContain("butler");
  });

  it("falls back so nobody goes without", function testSuperlativeFallback() {
    const blank = makeMember("Fresh");
    const awards = assignSuperlatives([blank], 0);

    expect(awards.get("Fresh").title).toBe("The Ironman");
  });
});

describe("computeGroupStats", function describeGroupStats() {
  it("sums member stats and finds the peak hour", function testGroupStats() {
    const first = { xpGained: 100, levelsGained: 2, collectionSlots: 5, hourTotals: new Array(24).fill(0) };
    const second = { xpGained: 50, levelsGained: 1, collectionSlots: 3, hourTotals: new Array(24).fill(0) };
    first.hourTotals[20] = 80;
    second.hourTotals[20] = 30;
    second.hourTotals[7] = 40;

    const group = computeGroupStats([first, second]);

    expect(group.xpGained).toBe(150);
    expect(group.levelsGained).toBe(3);
    expect(group.collectionSlots).toBe(8);
    expect(group.peakHour).toBe(20);
    expect(group.peakHourXP).toBe(110);
  });
});

describe("computeQuestStats", function describeQuestStats() {
  const questData = new Map([
    [0, { name: "Cook's Assistant", difficulty: "Novice", points: 1 }],
    [3, { name: "Dragon Slayer II", difficulty: "Grandmaster", points: 5 }],
    [7, { name: "Hopespear's Will", difficulty: "Novice", points: 0, miniquest: true }],
  ]);

  it("counts finished quests, points, and the hardest full quest", function testQuestStats() {
    const stats = computeQuestStats(["FINISHED", "FINISHED", "FINISHED"], questData);

    expect(stats).toMatchObject({ completed: 3, total: 3, points: 6, possiblePoints: 6 });
    expect(stats.hardest).toMatchObject({ name: "Dragon Slayer II", difficulty: "Grandmaster" });
  });

  it("ignores unfinished quests and miniquests for hardest", function testQuestFiltering() {
    const stats = computeQuestStats(["FINISHED", "IN_PROGRESS", "FINISHED"], questData);

    expect(stats).toMatchObject({ completed: 2, points: 1 });
    expect(stats.hardest).toMatchObject({ name: "Cook's Assistant" });
  });

  it("returns undefined without data", function testQuestStatsMissing() {
    expect(computeQuestStats(undefined, questData)).toBeUndefined();
    expect(computeQuestStats(["FINISHED"], undefined)).toBeUndefined();
  });
});

describe("computeDiaryStats", function describeDiaryStats() {
  it("counts complete tiers and tasks", function testDiaryStats() {
    const stats = computeDiaryStats({
      Ardougne: { Easy: [true, true], Medium: [true, false] },
      Varrock: { Easy: [true] },
    });

    expect(stats).toEqual({ tiersComplete: 2, tiersTotal: 3, tasksComplete: 4, tasksTotal: 5 });
  });

  it("returns undefined without data", function testDiaryStatsMissing() {
    expect(computeDiaryStats(undefined)).toBeUndefined();
  });
});

describe("computeTopFinds", function describeTopFinds() {
  it("ranks finds by GE price and flags group-unique items", function testTopFinds() {
    const items = new Map([
      [100, { name: "Dragon warhammer", highalch: 0, alchable: false }],
      [200, { name: "Ranarr seed", highalch: 0, alchable: false }],
      [300, { name: "Bronze dagger", highalch: 0, alchable: false }],
    ]);
    const gePrices = new Map([
      [100, 25_000_000],
      [200, 30_000],
      [300, 50],
    ]);
    const collectionLogs = new Map([
      [
        "Wise Old Man",
        new Map([
          [100, 1],
          [200, 4],
          [300, 1],
        ]),
      ],
      ["Gnome Child", new Map([[200, 2]])],
    ]);

    const finds = computeTopFinds({ member: "Wise Old Man", collectionLogs, items, gePrices, limit: 2 });

    expect(finds).toHaveLength(2);
    expect(finds[0]).toMatchObject({ itemID: 100, name: "Dragon warhammer", unique: true });
    expect(finds[1]).toMatchObject({ itemID: 200, quantity: 4, unique: false });
  });

  it("ranks by GE price and appends at most one elite milestone without displacing top drops", function testEliteMilestone() {
    const items = new Map([
      [2, { name: "Pharaoh's sceptre", highalch: 0, alchable: false }],
      [3, { name: "Zombie axe", highalch: 0, alchable: false }],
      [5, { name: "Granite maul", highalch: 0, alchable: false }],
      [4, { name: "Fire cape", highalch: 0, alchable: false }],
      [12954, { name: "Dragon defender", highalch: 0, alchable: false }],
      [7462, { name: "Barrows gloves", highalch: 0, alchable: false }],
    ]);
    const gePrices = new Map([
      [2, 30_000_000],
      [3, 8_000_000],
      [5, 300_000],
    ]);
    const collectionLogs = new Map([
      [
        "Active",
        new Map([
          [2, 1],
          [3, 1],
          [5, 1],
          [12954, 1],
        ]),
      ],
    ]);
    const memberProfiles = new Map([
      [
        "Active",
        {
          bank: new Map([
            [4, { itemID: 4, quantity: 1 }],
            [7462, { itemID: 7462, quantity: 1 }],
          ]),
        },
      ],
    ]);

    const finds = computeTopFinds({ member: "Active", collectionLogs, memberProfiles, items, gePrices });

    // The real drops lead; the Fire cape is the single milestone; the owned
    // Dragon defender and Barrows gloves stay out of the way entirely.
    expect(finds.map((find) => find.name)).toEqual(["Pharaoh's sceptre", "Zombie axe", "Fire cape"]);
    expect(finds[2].category).toBe("milestone");
  });

  it("uses a fallback milestone as the headline only when no drop is worth showing", function testFallbackMilestone() {
    const items = new Map([
      [10976, { name: "Long bone", highalch: 0, alchable: false }],
      [12954, { name: "Dragon defender", highalch: 0, alchable: false }],
    ]);
    const collectionLogs = new Map([["Casual", new Map([[10976, 1]])]]);
    const memberProfiles = new Map([["Casual", { equipment: new Map([["Shield", { itemID: 12954, quantity: 1 }]]) }]]);

    const finds = computeTopFinds({ member: "Casual", collectionLogs, memberProfiles, items, gePrices: new Map() });

    expect(finds.map((find) => find.name)).toEqual(["Dragon defender", "Long bone"]);
    expect(finds[0].category).toBe("milestone");
  });

  it("never uses a fallback milestone when a decent drop exists", function testNoFallbackWithDrops() {
    const items = new Map([
      [3, { name: "Zombie axe", highalch: 0, alchable: false }],
      [12954, { name: "Dragon defender", highalch: 0, alchable: false }],
    ]);
    const gePrices = new Map([[3, 8_000_000]]);
    const collectionLogs = new Map([["Mid", new Map([[3, 1]])]]);
    const memberProfiles = new Map([["Mid", { equipment: new Map([["Shield", { itemID: 12954, quantity: 1 }]]) }]]);

    const finds = computeTopFinds({ member: "Mid", collectionLogs, memberProfiles, items, gePrices });

    expect(finds.map((find) => find.name)).toEqual(["Zombie axe"]);
  });

  it("marks gear-held items unique only when no other member owns one", function testGearUniqueness() {
    const items = new Map([[12954, { name: "Dragon defender", highalch: 0, alchable: false }]]);
    const collectionLogs = new Map([
      ["A", new Map([[12954, 1]])],
      ["B", new Map()],
    ]);
    const memberProfiles = new Map([
      ["A", {}],
      ["B", { equipment: new Map([["Shield", { itemID: 12954, quantity: 1 }]]) }],
    ]);

    const finds = computeTopFinds({ member: "B", collectionLogs, memberProfiles, items, gePrices: new Map() });

    expect(finds[0].name).toBe("Dragon defender");
    expect(finds[0].unique).toBe(false);
  });

  it("returns an empty list without a log or item data", function testTopFindsMissing() {
    expect(computeTopFinds({ member: "X", collectionLogs: new Map(), items: new Map(), gePrices: new Map() })).toEqual(
      [],
    );
  });
});

describe("computeTeamRest", function describeTeamRest() {
  it("counts days nobody played and names the quietest complete month", function testTeamRest() {
    const rest = computeTeamRest(
      [
        { member: "A", activeDays: ["2026-01-05", "2026-02-01", "2026-02-02"] },
        { member: "B", activeDays: ["2026-02-01", "2026-02-03"] },
      ],
      { year: 2026, daysSoFar: 90, currentMonth: 3 },
    );

    // 4 distinct team-active days out of 90.
    expect(rest.grassDays).toBe(86);
    expect(rest.quietestMonth).toBe("March");
    expect(rest.busiestMonth).toBe("February");
  });

  it("returns undefined with no members", function testTeamRestEmpty() {
    expect(computeTeamRest([], { year: 2026, daysSoFar: 90, currentMonth: 3 })).toBeUndefined();
  });
});

describe("computeRaceSeries", function describeRaceSeries() {
  it("produces monotonic values ending at the year's gain, with drama-weighted progress", function testRaceSeries() {
    const endTime = Date.UTC(2026, 8, 1);
    const series = computeRaceSeries({
      memberSamples: new Map([
        [
          "Wise Old Man",
          [
            sample(new Date(Date.UTC(2025, 11, 1)), { [ATTACK]: 1_000 }),
            sample(new Date(Date.UTC(2026, 5, 1)), { [ATTACK]: 2_000 }),
            sample(new Date(Date.UTC(2026, 7, 1)), { [ATTACK]: 9_000 }),
          ],
        ],
      ]),
      yearStart: YEAR_START,
      steps: 40,
      endTime,
    });

    expect(series.times).toHaveLength(41);
    expect(series.times[0]).toBe(YEAR_START.getTime());
    expect(series.times.at(-1)).toBe(endTime);

    const values = series.members[0].values;
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(8_000);
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]).toBeGreaterThanOrEqual(values[index - 1]);
    }

    expect(series.progressAt[0]).toBe(0);
    expect(series.progressAt.at(-1)).toBeCloseTo(1);
    // The step containing the big June->August jump gets far more of the
    // playback than an empty step of equal length.
    const jumpStep = values.findIndex((value, index) => index > 0 && value > values[index - 1] + 5_000);
    const jumpShare = series.progressAt[jumpStep] - series.progressAt[jumpStep - 1];
    const quietShare = series.progressAt[1] - series.progressAt[0];
    expect(jumpShare).toBeGreaterThan(quietShare * 10);
  });

  it("returns undefined without members or before the year starts", function testRaceSeriesEmpty() {
    expect(computeRaceSeries({ memberSamples: new Map(), yearStart: YEAR_START })).toBeUndefined();
    expect(
      computeRaceSeries({ memberSamples: new Map(), yearStart: YEAR_START, endTime: YEAR_START.getTime() - 1 }),
    ).toBeUndefined();
  });
});

describe("sumExperience", function describeSum() {
  it("totals a sample's skill array", function testSum() {
    expect(sumExperience(sample(new Date(), { [ATTACK]: 5, [FISHING]: 7 }))).toBe(12);
  });
});
