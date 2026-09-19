<script setup>
  import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
  import { skillIcons } from "../../game/skill";
  import CachedImage from "../cached-image/CachedImage.vue";
  import { bossArtUrl } from "./wrapped-art";
  import { assignSuperlatives, computeTeamRest, formatDay, formatShortXP, formatXP } from "./wrapped-data";

  const props = defineProps({
    groupName: { type: String, required: true },
    year: { type: Number, required: true },
    memberStats: { type: Array, required: true },
    groupStats: { type: Object, required: true },
    raceSeries: { type: Object, default: undefined },
  });
  const emit = defineEmits(["finished"]);

  const SLIDE_MS = 8000;
  const RACE_MS = 14_000;
  const RACE_HOLD_MS = 3_000;

  function slideDurationMs(name) {
    return name === "race" ? RACE_MS + RACE_HOLD_MS : SLIDE_MS;
  }

  // Nobody should look like the default leader: members are shuffled once per
  // viewing, and list slides rotate who goes first on top of that. The race
  // is the one slide that deliberately ranks.
  const shuffleOrder = [...props.memberStats.map((member) => member.member)].sort(() => Math.random() - 0.5);

  const shuffledMembers = computed(function getShuffledMembers() {
    const byName = new Map(props.memberStats.map((member) => [member.member, member]));
    const known = shuffleOrder.filter((name) => byName.has(name)).map((name) => byName.get(name));
    const extras = props.memberStats.filter((member) => !shuffleOrder.includes(member.member));
    return [...known, ...extras];
  });

  function rotatedMembers(offset) {
    const members = shuffledMembers.value;
    if (members.length === 0) return members;
    const shift = offset % members.length;
    return [...members.slice(shift), ...members.slice(0, shift)];
  }

  const daysSoFar = Math.max(1, Math.floor((Date.now() - Date.UTC(props.year, 0, 1)) / 86_400_000));

  const superlatives = computed(function getSuperlatives() {
    return assignSuperlatives(props.memberStats, daysSoFar);
  });

  const teamRest = computed(function getTeamRest() {
    return computeTeamRest(props.memberStats, {
      year: props.year,
      daysSoFar,
      currentMonth: new Date().getMonth(),
    });
  });

  const slides = computed(function buildSlides() {
    const built = ["intro", "group-xp"];
    if (props.raceSeries?.members.some((member) => member.values.at(-1) > 0)) built.push("race");
    for (const member of shuffledMembers.value) {
      built.push(`spotlight:${member.member}`);
    }
    if (teamRest.value?.grassDays > 0) built.push("team-grass");
    if (props.memberStats.some((member) => member.questStats)) built.push("quests");
    if (props.memberStats.some((member) => member.diaryStats)) built.push("diaries");
    built.push("outro");
    return built;
  });

  const index = ref(0);
  const slide = computed(() => slides.value[index.value]);
  let timer;

  const spotlightMember = computed(function getSpotlightMember() {
    if (!slide.value?.startsWith("spotlight:")) return undefined;
    const name = slide.value.slice("spotlight:".length);
    return props.memberStats.find((member) => member.member === name);
  });

  const FIND_LABELS = { drop: "Prized drop", pet: "The pet", milestone: "Milestone" };

  // Best find plus the milestone (which sits last for members with real
  // drops), so an earned Fire cape still makes the slide.
  const spotlightFinds = computed(function getSpotlightFinds() {
    const finds = spotlightMember.value?.topFinds ?? [];
    if (finds.length === 0) return [];
    const milestone = finds.find((find) => find.category === "milestone");
    const second = milestone && milestone !== finds[0] ? milestone : finds[1];
    return second ? [finds[0], second] : [finds[0]];
  });

  function scheduleAdvance() {
    clearTimeout(timer);
    if (slide.value !== "outro") {
      timer = setTimeout(next, slideDurationMs(slide.value));
    }
  }

  function next() {
    if (index.value >= slides.value.length - 1) {
      emit("finished");
      return;
    }
    index.value += 1;
  }

  function previous() {
    index.value = Math.max(0, index.value - 1);
  }

  function onTap(event) {
    const { left, width } = event.currentTarget.getBoundingClientRect();
    if (event.clientX - left < width / 3) {
      previous();
    } else {
      next();
    }
  }

  function onKey(event) {
    if (event.key === "ArrowRight" || event.key === " ") next();
    else if (event.key === "ArrowLeft") previous();
    else if (event.key === "Escape") emit("finished");
    else return;
    event.preventDefault();
  }

  // Watching the slide NAME (not just the index) also reschedules when
  // background prefetch inserts a slide at the current position.
  watch(slide, function onSlideChange(name) {
    scheduleAdvance();
    if (name === "race") {
      startRace();
    } else {
      cancelAnimationFrame(raceRaf);
    }
    if (name === "group-xp") {
      startXpCount();
    } else {
      cancelXpCount();
    }
  });
  onMounted(function startStory() {
    scheduleAdvance();
    if (slide.value === "group-xp") {
      startXpCount();
    }
    window.addEventListener("keydown", onKey);
  });
  onBeforeUnmount(function stopStory() {
    clearTimeout(timer);
    cancelAnimationFrame(raceRaf);
    cancelXpCount();
    window.removeEventListener("keydown", onKey);
  });

  // ---- group XP odometer ----
  // Two phases, like a prize wheel: a ~1.8s sprint through everything except
  // the last few XP, then those final units click in ONE AT A TIME with the
  // gaps stretching out until the total lands.

  const SPRINT_MS = 1800;
  const DRIP_UNITS = 12;
  const DRIP_FIRST_MS = 60;
  const DRIP_GROWTH = 1.18;
  // The final tick waits extra long — long enough that the last +1 is a
  // little surprise.
  const FINAL_TICK_FACTOR = 2.8;
  const xpCount = ref(0);
  let countRaf;
  let countTimer;

  function cancelXpCount() {
    cancelAnimationFrame(countRaf);
    clearTimeout(countTimer);
  }

  function startXpCount() {
    cancelXpCount();
    const total = props.groupStats.xpGained;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      xpCount.value = total;
      return;
    }

    const dripStart = Math.max(0, total - DRIP_UNITS);

    function drip(delay) {
      countTimer = setTimeout(function tickOne() {
        xpCount.value += 1;
        if (xpCount.value < total) {
          const isFinalTick = xpCount.value === total - 1;
          drip(delay * DRIP_GROWTH * (isFinalTick ? FINAL_TICK_FACTOR : 1));
        }
      }, delay);
    }

    xpCount.value = 0;
    const startedAt = performance.now();
    function sprint(timestamp) {
      const progress = Math.min(1, (timestamp - startedAt) / SPRINT_MS);
      const eased = progress >= 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      xpCount.value = Math.round(dripStart * eased);
      if (progress < 1) {
        countRaf = requestAnimationFrame(sprint);
      } else if (xpCount.value < total) {
        drip(DRIP_FIRST_MS);
      }
    }
    countRaf = requestAnimationFrame(sprint);
  }

  // ---- race slide playback ----

  const raceProgress = ref(0);
  let raceRaf;

  function startRace() {
    cancelAnimationFrame(raceRaf);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      raceProgress.value = 1;
      return;
    }
    raceProgress.value = 0;
    const startedAt = performance.now();
    function tick(timestamp) {
      raceProgress.value = Math.min(1, (timestamp - startedAt) / RACE_MS);
      if (raceProgress.value < 1) {
        raceRaf = requestAnimationFrame(tick);
      }
    }
    raceRaf = requestAnimationFrame(tick);
  }

  const raceFrame = computed(function computeRaceFrame() {
    const series = props.raceSeries;
    if (!series) {
      return undefined;
    }
    const { times, members, progressAt } = series;

    // Map animation progress through the drama-weighted timeline: find the
    // step interval containing it and interpolate inside it.
    const progress = raceProgress.value;
    let step = progressAt.length - 1;
    for (let candidate = 1; candidate < progressAt.length; candidate += 1) {
      if (progressAt[candidate] >= progress) {
        step = candidate;
        break;
      }
    }
    const span = progressAt[step] - progressAt[step - 1];
    const within = span > 0 ? (progress - progressAt[step - 1]) / span : 1;

    const time = times[step - 1] + (times[step] - times[step - 1]) * within;
    const rows = members
      .map(function valueNow(member) {
        const value = member.values[step - 1] + (member.values[step] - member.values[step - 1]) * within;
        return { member: member.member, hue: member.hue, value };
      })
      .sort((first, second) => second.value - first.value);
    const leader = Math.max(1, rows[0].value);

    return {
      dateLabel: new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "long" }),
      rows: rows.map(function withWidth(row) {
        return { ...row, pct: Math.max(1, Math.round((row.value / leader) * 100)) };
      }),
    };
  });

  const hardestQuest = computed(function findHardestQuest() {
    let best;
    for (const member of props.memberStats) {
      const hardest = member.questStats?.hardest;
      if (hardest && (!best || hardest.rank > best.rank)) {
        best = hardest;
      }
    }
    return best;
  });

  function memberStyle(member) {
    return { "--member-hue": `${member.hue}deg` };
  }
</script>

<template>
  <!-- Teleported like Modal.vue: the app shell has transformed ancestors that
       would otherwise trap the fixed overlay in the content column. -->
  <Teleport to="body">
    <div class="wrapped-story" @click="onTap">
      <div class="wrapped-story-progress" aria-hidden="true">
        <div v-for="(name, barIndex) in slides" :key="name" class="wrapped-story-bar">
          <div
            class="wrapped-story-bar-fill"
            :class="{ done: barIndex < index, active: barIndex === index && name !== 'outro' }"
            :style="barIndex === index ? { animationDuration: `${slideDurationMs(name)}ms` } : undefined"
          ></div>
        </div>
      </div>
      <button type="button" class="wrapped-story-skip" @click.stop="emit('finished')">Skip ›</button>

      <Transition name="wrapped-slide" mode="out-in">
        <section v-if="slide === 'intro'" key="intro" class="wrapped-slide">
          <p class="wrapped-kicker">{{ year }} so far</p>
          <h1 class="wrapped-slide-title">{{ groupName }}</h1>
          <p class="wrapped-slide-caption">Your year on Gielinor, one slide at a time.</p>
          <p class="wrapped-slide-hint">Tap to continue</p>
        </section>

        <section v-else-if="slide === 'group-xp'" key="group-xp" class="wrapped-slide">
          <p class="wrapped-slide-caption">Together you earned</p>
          <p class="wrapped-slide-number">{{ formatXP(xpCount) }}</p>
          <p class="wrapped-slide-caption">XP · {{ groupStats.levelsGained }} levels gained</p>
        </section>

        <section v-else-if="slide === 'race'" key="race" class="wrapped-slide wrapped-slide-race">
          <h2 class="wrapped-slide-heading">The race</h2>
          <p class="wrapped-race-date">{{ raceFrame?.dateLabel }}</p>
          <TransitionGroup tag="div" name="wrapped-race" class="wrapped-race-bars">
            <div
              v-for="row in raceFrame?.rows ?? []"
              :key="row.member"
              class="wrapped-race-row"
              :style="{ '--member-hue': `${row.hue}deg` }"
            >
              <span class="wrapped-race-name">{{ row.member }}</span>
              <div class="wrapped-race-track">
                <div class="wrapped-race-fill" :style="{ width: `${row.pct}%` }"></div>
              </div>
              <span class="wrapped-race-value">{{ formatShortXP(Math.round(row.value)) }}</span>
            </div>
          </TransitionGroup>
          <p class="wrapped-slide-caption">Cumulative XP gained through {{ year }} — all for the same bank.</p>
        </section>

        <section
          v-else-if="spotlightMember"
          :key="slide"
          class="wrapped-slide wrapped-spotlight"
          :style="memberStyle(spotlightMember)"
        >
          <p class="wrapped-kicker wrapped-spotlight-award">{{ superlatives.get(spotlightMember.member)?.title }}</p>
          <h2 class="wrapped-slide-title wrapped-spotlight-name">{{ spotlightMember.member }}</h2>
          <p class="wrapped-slide-caption">{{ superlatives.get(spotlightMember.member)?.detail }}</p>

          <ul class="wrapped-spotlight-facts">
            <li v-if="spotlightMember.topSkills?.[0]?.xp > 0">
              <CachedImage class="wrapped-skill-icon" :src="skillIcons[spotlightMember.topSkills[0].skill]" :alt="''" />
              <span>
                {{ spotlightMember.topSkills[0].skill }} was the obsession —
                <template v-if="spotlightMember.topSkills[0].levels > 0"
                  >+{{ spotlightMember.topSkills[0].levels }} levels</template
                >
                <template v-else
                  >{{ Math.round((spotlightMember.topSkills[0].xp / spotlightMember.xpGained) * 100) }}% of their
                  year</template
                >
              </span>
            </li>
            <li v-if="spotlightMember.biggestDay">
              <span>
                Best day: {{ formatDay(spotlightMember.biggestDay.day) }} ·
                {{ formatShortXP(spotlightMember.biggestDay.xp) }} XP
              </span>
            </li>
            <li v-if="spotlightMember.longestStreak > 1">
              <span>{{ spotlightMember.longestStreak }} days in a row at the peak</span>
            </li>
            <li v-if="spotlightMember.topBosses?.[0]">
              <img
                v-if="bossArtUrl(spotlightMember.topBosses[0][0])"
                class="wrapped-spotlight-boss"
                :src="bossArtUrl(spotlightMember.topBosses[0][0])"
                :alt="spotlightMember.topBosses[0][0]"
                loading="lazy"
                referrerpolicy="no-referrer"
              />
              <span>
                {{ spotlightMember.topBosses[0][0] }} fell {{ spotlightMember.topBosses[0][1] }} times (all-time)
              </span>
            </li>
            <li v-for="find in spotlightFinds" :key="find.itemID">
              <CachedImage class="wrapped-find-icon" :src="find.imageURL" :alt="''" />
              <span>
                {{ FIND_LABELS[find.category] ?? "Find" }}: {{ find.name
                }}<template v-if="find.unique"> — nobody else has one</template>
              </span>
            </li>
          </ul>
        </section>

        <section v-else-if="slide === 'team-grass'" key="team-grass" class="wrapped-slide">
          <p class="wrapped-kicker">The grass report</p>
          <p class="wrapped-slide-number">{{ teamRest.grassDays }}</p>
          <p class="wrapped-slide-caption">days this year when not a single one of you logged a drop of XP. Health!</p>
          <p v-if="teamRest.quietestMonth" class="wrapped-slide-caption">
            {{ teamRest.quietestMonth }} was practically an outdoor month<template v-if="teamRest.busiestMonth"
              >; {{ teamRest.busiestMonth }}, less so</template
            >.
          </p>
        </section>

        <section v-else-if="slide === 'quests'" key="quests" class="wrapped-slide">
          <h2 class="wrapped-slide-heading">Questing</h2>
          <ul class="wrapped-slide-members">
            <li v-for="member in rotatedMembers(1)" :key="member.member" :style="memberStyle(member)">
              <span class="wrapped-slide-member-name">{{ member.member }}</span>
              <span v-if="member.questStats" class="wrapped-slide-member-value">
                {{ member.questStats.completed }}/{{ member.questStats.total }} quests ·
                {{ member.questStats.points }} QP
              </span>
            </li>
          </ul>
          <p v-if="hardestQuest" class="wrapped-slide-caption">
            The group's hardest conquest: <strong>{{ hardestQuest.name }}</strong> ({{ hardestQuest.difficulty }})
          </p>
          <p class="wrapped-slide-footnote">Where you stand today — the site doesn't record when each quest fell.</p>
        </section>

        <section v-else-if="slide === 'diaries'" key="diaries" class="wrapped-slide">
          <h2 class="wrapped-slide-heading">Achievement diaries</h2>
          <ul class="wrapped-slide-members">
            <li v-for="member in rotatedMembers(2)" :key="member.member" :style="memberStyle(member)">
              <span class="wrapped-slide-member-name">{{ member.member }}</span>
              <span v-if="member.diaryStats" class="wrapped-slide-member-value">
                {{ member.diaryStats.tiersComplete }}/{{ member.diaryStats.tiersTotal }} tiers ·
                {{ member.diaryStats.tasksComplete }} tasks
              </span>
            </li>
          </ul>
        </section>

        <section v-else key="outro" class="wrapped-slide">
          <p class="wrapped-kicker">{{ year }} so far</p>
          <h2 class="wrapped-slide-title">That's your year. So far.</h2>
          <button type="button" class="wrapped-story-cta rsborder-tiny rsbackground" @click.stop="emit('finished')">
            See the full breakdown
          </button>
        </section>
      </Transition>
    </div>
  </Teleport>
</template>
