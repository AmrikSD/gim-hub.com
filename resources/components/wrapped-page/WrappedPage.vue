<script setup>
  import { computed, onMounted, ref, shallowRef, watch } from "vue";
  import { Line } from "vue-chartjs";
  import { Chart as ChartJS, Legend, LinearScale, LineElement, PointElement, TimeScale, Tooltip } from "chart.js";
  import { useApiStore } from "../../stores/api";
  import { useGameDataStore } from "../../stores/game-data";
  import { useGroupStore } from "../../stores/group";
  import { skillIcons } from "../../game/skill";
  import { composeItemIconHref } from "../../game/items";
  import { memberColorHues } from "../../game/member-colors";
  import { useLocalStorage } from "../../composables/local-storage";
  import CachedImage from "../cached-image/CachedImage.vue";
  import LoadingScreen from "../loading-screen/LoadingScreen.vue";
  import WrappedStory from "./WrappedStory.vue";
  import {
    assignSuperlatives,
    computeDiaryStats,
    computeGroupStats,
    computeMemberStats,
    computeQuestStats,
    computeRaceSeries,
    computeTopFinds,
    formatDay,
    formatShortXP,
    formatXP,
    mergeSkillDataResponses,
    sumExperience,
  } from "./wrapped-data";
  import "chartjs-adapter-date-fns";
  import "./wrapped-page.css";

  ChartJS.register(TimeScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

  // Match the site's chart theming (same mutation SkillGraph.vue applies), so
  // the chart doesn't depend on the user having visited /group/history first.
  const bodyStyle = getComputedStyle(document.body);
  ChartJS.defaults.font.family = "rssmall";
  ChartJS.defaults.font.size = 16;
  ChartJS.defaults.color = bodyStyle.getPropertyValue("--white");
  ChartJS.defaults.scale.grid.color = bodyStyle.getPropertyValue("--graph-grid-border");

  const YEAR = 2026;
  const YEAR_START = new Date(Date.UTC(YEAR, 0, 1));

  const apiStore = useApiStore();
  const gameDataStore = useGameDataStore();
  const groupStore = useGroupStore();

  const loading = ref(true);
  const error = ref(undefined);
  const warning = ref(undefined);
  const memberSamples = shallowRef(new Map());
  const collectionLogs = shallowRef(new Map());
  const bossKcByMember = shallowRef(new Map());
  const memberProfiles = shallowRef(new Map());

  const [storySeen, setStorySeen] = useLocalStorage({
    key: `wrapped-${YEAR}-seen`,
    defaultValue: undefined,
    validator: (value) => value || undefined,
  });
  const mode = ref(storySeen.value ? "summary" : "story");

  function finishStory() {
    setStorySeen("true");
    mode.value = "summary";
  }

  function replayStory() {
    mode.value = "story";
  }

  // Self-imposed politeness: at most a few requests in flight, with a pause
  // between batches. One wrapped view costs less than a minute of the
  // dashboard's normal polling, but there's no reason to burst.
  const FETCH_BATCH_SIZE = 3;
  const FETCH_PAUSE_MS = 300;

  function pause(ms) {
    return new Promise(function schedule(resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function fetchYearOfSkillData() {
    // End a minute in the past: the backend rejects end times after ITS
    // clock, and the client clock may run ahead of it.
    const now = new Date(Date.now() - 60_000);
    const windows = [];
    for (let start = YEAR_START; start < now;) {
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      windows.push({ start, end: end < now ? end : now });
      start = end;
    }

    const settled = [];
    for (let index = 0; index < windows.length; index += FETCH_BATCH_SIZE) {
      const batch = await Promise.allSettled(
        windows.slice(index, index + FETCH_BATCH_SIZE).map(function fetchWindow(range) {
          return apiStore.client.fetchSkillData(range);
        }),
      );
      settled.push(...batch);
      if (index + FETCH_BATCH_SIZE < windows.length) {
        await pause(FETCH_PAUSE_MS);
      }
    }

    // A failed month drops that month rather than the whole page — except the
    // first window, which carries the pre-January baseline sample every
    // annual total hinges on; losing it would silently exclude January.
    if (settled.length === 0 || settled[0].status === "rejected") {
      throw settled[0]?.reason ?? new Error("No skill data windows to fetch");
    }
    const responses = [];
    settled.forEach(function collectResponse(result, index) {
      if (result.status === "fulfilled") {
        responses.push(result.value);
      } else {
        console.warn(`Skill data window ${windows[index].start.toISOString()} failed`, result.reason);
      }
    });

    return mergeSkillDataResponses(responses);
  }

  async function loadWrappedData() {
    const client = apiStore.client;
    if (!client) {
      return;
    }

    // Guard every commit on the client still being current: switching groups
    // swaps the client mid-flight and a slow response from the old group must
    // not overwrite the new group's data (same pattern as stores/game-data.js).
    const isStale = () => apiStore.client !== client;

    loading.value = true;
    error.value = undefined;
    warning.value = undefined;
    try {
      // Only skill data blocks the story: the first slides need nothing else.
      const samples = await fetchYearOfSkillData();
      if (isStale()) return;
      memberSamples.value = samples;
    } catch (reason) {
      if (isStale()) return;
      console.error("Failed to load wrapped data", reason);
      error.value = "Failed to load the year's data. Refresh to retry.";
      return;
    } finally {
      if (!isStale()) {
        loading.value = false;
      }
    }

    // Everything else prefetches in the background, one request at a time,
    // while the intro slides play; slides that need the data appear as it
    // lands. All of it is optional — failures leave sections hidden.
    const steps = [
      async function loadCollectionLogs() {
        const logs = await client.fetchGroupCollectionLogs();
        if (!isStale()) collectionLogs.value = logs;
      },
      async function loadProfiles() {
        const members = await client.fetchGroupData(new Date(0));
        if (!isStale()) memberProfiles.value = new Map(members.map((member) => [member.name, member]));
      },
      async function loadGameData() {
        await gameDataStore.load(client);
      },
      ...[...memberSamples.value.keys()].map(function makeKcStep(member) {
        return async function loadKc() {
          const kc = await client.fetchMemberHiscores(member);
          if (isStale()) return;
          const next = new Map(bossKcByMember.value);
          next.set(member, kc);
          bossKcByMember.value = next;
        };
      }),
    ];
    for (const step of steps) {
      if (isStale()) return;
      try {
        await step();
      } catch (reason) {
        console.warn("Wrapped prefetch step failed", reason);
        if (!isStale()) {
          warning.value = "Some data failed to load, so a few sections may be missing. Refresh to retry.";
        }
      }
      await pause(FETCH_PAUSE_MS);
    }
  }

  onMounted(loadWrappedData);

  // Switching groups via the group switcher swaps the client without
  // remounting the route; refetch so the stats match the credentials shown.
  watch(function getClient() {
    return apiStore.client;
  }, loadWrappedData);

  function memberHue(member, index) {
    return groupStore.memberColors.get(member)?.hueDegrees ?? memberColorHues[index % memberColorHues.length];
  }

  const groupName = computed(function getGroupName() {
    return apiStore.credentials?.name ?? "Your group";
  });

  const memberStats = computed(function getMemberStats() {
    const stats = computeMemberStats({
      memberSamples: memberSamples.value,
      collectionLogs: collectionLogs.value,
      bossKcByMember: bossKcByMember.value,
      yearStart: YEAR_START,
    });
    const items = gameDataStore.gameData.items;
    const gePrices = gameDataStore.gameData.gePrices;
    const questData = gameDataStore.gameData.quests;

    return stats.map(function enrichMember(member, index) {
      const profile = memberProfiles.value.get(member.member);
      return {
        ...member,
        hue: memberHue(member.member, index),
        questStats: computeQuestStats(profile?.quests, questData),
        diaryStats: computeDiaryStats(profile?.diaries),
        topFinds: computeTopFinds({
          member: member.member,
          collectionLogs: collectionLogs.value,
          memberProfiles: memberProfiles.value,
          items,
          gePrices,
          itemTags: gameDataStore.gameData.itemTags,
        }).map(function addIcon(find) {
          return {
            ...find,
            imageURL: composeItemIconHref({ itemID: find.itemID, quantity: find.quantity }, items?.get(find.itemID)),
          };
        }),
      };
    });
  });

  const groupStats = computed(function getGroupStats() {
    return computeGroupStats(memberStats.value);
  });

  const superlatives = computed(function getSuperlatives() {
    const daysSoFar = Math.max(1, Math.floor((Date.now() - YEAR_START.getTime()) / 86_400_000));
    return assignSuperlatives(memberStats.value, daysSoFar);
  });

  const raceSeries = computed(function getRaceSeries() {
    const series = computeRaceSeries({ memberSamples: memberSamples.value, yearStart: YEAR_START });
    if (!series) {
      return undefined;
    }
    const hues = new Map(memberStats.value.map((member) => [member.member, member.hue]));
    return {
      ...series,
      members: series.members.map((member) => ({ ...member, hue: hues.get(member.member) ?? 32 })),
    };
  });

  const chart = computed(function buildChart() {
    const datasets = [];
    let index = 0;
    for (const [member, samples] of memberSamples.value) {
      if (samples.length === 0) continue;
      const baseline = samples.findLast((sample) => sample.time <= YEAR_START) ?? samples[0];
      const baselineTotal = sumExperience(baseline);
      const hue = memberHue(member, index);
      datasets.push({
        label: member,
        data: samples.map(function toPoint(sample) {
          return { x: sample.time.getTime(), y: Math.max(0, sumExperience(sample) - baselineTotal) };
        }),
        borderColor: `hsl(${hue}deg 60% 50%)`,
        backgroundColor: `hsl(${hue}deg 60% 40%)`,
        stepped: true,
        pointRadius: 0,
        pointHoverRadius: 3,
        borderWidth: 2,
      });
      index += 1;
    }

    return {
      data: { datasets },
      options: {
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        responsive: true,
        interaction: { intersect: false, mode: "nearest", axis: "x" },
        plugins: { legend: { position: "top" } },
        scales: {
          x: { type: "time", min: YEAR_START.getTime(), max: Date.now(), time: { minUnit: "day" } },
          y: { title: { display: true, text: "XP gained" }, type: "linear", min: 0 },
        },
      },
    };
  });

  function formatHour(hour) {
    return `${String(hour).padStart(2, "0")}:00`;
  }
</script>

<template>
  <div id="wrapped-page" :class="{ 'wrapped-page-story': !loading && !error && mode === 'story' }">
    <LoadingScreen v-if="loading" />
    <div v-else-if="error" class="wrapped-error rsborder rsbackground">{{ error }}</div>

    <WrappedStory
      v-else-if="mode === 'story'"
      :group-name="groupName"
      :year="YEAR"
      :member-stats="memberStats"
      :group-stats="groupStats"
      :race-series="raceSeries"
      @finished="finishStory"
    />

    <template v-else>
      <div v-if="warning" class="wrapped-warning rsborder-tiny rsbackground" role="alert">{{ warning }}</div>

      <section class="wrapped-hero rsborder rsbackground">
        <p class="wrapped-kicker">{{ YEAR }} so far</p>
        <h1>{{ groupName }} Wrapped</h1>
        <p class="wrapped-hero-number">{{ formatXP(groupStats.xpGained) }}</p>
        <p class="wrapped-hero-caption">
          XP earned together · {{ groupStats.levelsGained }} levels gained · {{ groupStats.collectionSlots }} collection
          log slots across the group (all-time)
        </p>
        <button type="button" class="wrapped-replay rsborder-tiny rsbackground rsbackground-hover" @click="replayStory">
          ▶ Replay the story
        </button>
      </section>

      <section class="wrapped-chart rsborder rsbackground" aria-labelledby="wrapped-chart-heading">
        <h2 id="wrapped-chart-heading">The year, hour by hour</h2>
        <div class="wrapped-chart-canvas">
          <Line :data="chart.data" :options="chart.options" />
        </div>
      </section>

      <section class="wrapped-members" aria-label="Member highlights">
        <article
          v-for="member in memberStats"
          :key="member.member"
          class="wrapped-member rsborder rsbackground"
          :style="{ '--member-hue': `${member.hue}deg` }"
        >
          <header class="wrapped-member-header">
            <h3>{{ member.member }}</h3>
            <span class="wrapped-member-total">total level {{ member.totalLevel }}</span>
          </header>
          <p class="wrapped-member-award">{{ superlatives.get(member.member)?.title }}</p>

          <p class="wrapped-member-number">{{ formatXP(member.xpGained) }} XP</p>
          <p v-if="member.levelsGained > 0" class="wrapped-member-caption">
            +{{ member.levelsGained }} levels this year<template v-if="member.new99s.length">
              · reached 99 {{ member.new99s.join(", ") }}</template
            >
          </p>

          <ul class="wrapped-member-skills">
            <li v-for="entry in member.topSkills" :key="entry.skill">
              <CachedImage class="wrapped-skill-icon" :src="skillIcons[entry.skill]" :alt="entry.skill" />
              <span>{{ entry.skill }}</span>
              <strong>{{ formatShortXP(entry.xp) }}</strong>
            </li>
          </ul>

          <dl class="wrapped-member-facts">
            <div v-if="member.biggestDay">
              <dt>Biggest day</dt>
              <dd>{{ formatDay(member.biggestDay.day) }} · {{ formatShortXP(member.biggestDay.xp) }} XP</dd>
            </div>
            <div>
              <dt>Days played</dt>
              <dd>{{ member.activeDayCount }} · longest streak {{ member.longestStreak }}</dd>
            </div>
            <div v-if="member.questStats">
              <dt>Quests</dt>
              <dd>
                {{ member.questStats.completed }}/{{ member.questStats.total }} · {{ member.questStats.points }} QP
              </dd>
            </div>
            <div v-if="member.diaryStats">
              <dt>Diary tiers</dt>
              <dd>{{ member.diaryStats.tiersComplete }}/{{ member.diaryStats.tiersTotal }}</dd>
            </div>
            <div>
              <dt>Collection log</dt>
              <dd>{{ member.collectionSlots }} slots (all-time)</dd>
            </div>
            <div v-if="member.topBosses.length">
              <dt>Most-slain (all-time)</dt>
              <dd>
                <template v-for="([boss, killCount], bossIndex) in member.topBosses" :key="boss">
                  <template v-if="bossIndex > 0"> · </template>{{ boss }} ×{{ killCount }}
                </template>
              </dd>
            </div>
          </dl>

          <ul v-if="member.topFinds.length" class="wrapped-member-finds">
            <li v-for="find in member.topFinds" :key="find.itemID" :title="find.name">
              <CachedImage class="wrapped-find-icon" :src="find.imageURL" :alt="find.name" />
              <span v-if="find.gePrice > 0">{{ formatShortXP(find.gePrice) }} gp</span>
              <span v-if="find.unique" class="wrapped-find-unique" title="Only they have this">★</span>
            </li>
          </ul>

          <p v-if="member.unattributedXP > 0" class="wrapped-member-footnote">
            {{ formatShortXP(member.unattributedXP) }} XP was earned during tracking gaps and is counted in totals but
            not daily stats.
          </p>
        </article>
      </section>

      <section v-if="groupStats.peakHour !== undefined" class="wrapped-hours rsborder rsbackground">
        <h2>When {{ groupName }} plays</h2>
        <p>
          Peak hour: <strong>{{ formatHour(groupStats.peakHour) }}</strong> ({{ formatShortXP(groupStats.peakHourXP) }}
          XP earned in that hour of the day, your local time)
        </p>
        <div class="wrapped-hour-bars" role="img" aria-label="XP by hour of day">
          <div
            v-for="(xp, hour) in groupStats.hourTotals"
            :key="hour"
            class="wrapped-hour-bar"
            :data-tooltip="`${formatHour(hour)} — ${formatShortXP(xp)} XP`"
          >
            <div
              class="wrapped-hour-fill"
              :style="{ height: `${groupStats.peakHourXP ? Math.round((xp / groupStats.peakHourXP) * 100) : 0}%` }"
            ></div>
            <span v-if="hour % 6 === 0" class="wrapped-hour-label">{{ formatHour(hour) }}</span>
          </div>
        </div>
      </section>

      <p class="wrapped-footnote">
        Built from the skill history this site already records. Hourly detail exists for the last 12 months; older
        activity is monthly. Days and hours use your local time; XP that can't be pinned to a single day is counted in
        totals but excluded from daily records. Quests, diaries, collection log and kill counts are where you stand
        today — the site doesn't record when each one happened.
      </p>
    </template>
  </div>
</template>
