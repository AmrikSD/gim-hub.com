// Artwork lookups for the wrapped story slides.
//
// Boss art is hotlinked from the OSRS wiki by exact file name. Add entries as
// new bosses show up on the group's hiscores; unknown bosses simply render
// without art (bossArtUrl returns undefined), so missing entries never break
// the page.

const WIKI_IMAGES = "https://oldschool.runescape.wiki/images/";

const BOSS_ART_FILES = {
  "Barrows Chests": "Chest_(Barrows).png",
  "Deranged Archaeologist": "Deranged_archaeologist.png",
  "Lunar Chests": "Lunar_Chest_(closed).png",
  Obor: "Obor.png",
  Scurrius: "Scurrius.png",
  Tempoross: "Tempoross.png",
  Vorkath: "Vorkath.png",
  Zulrah: "Zulrah_(serpentine).png",
};

export function bossArtUrl(bossName) {
  const file = BOSS_ART_FILES[bossName];
  return file ? `${WIKI_IMAGES}${file}` : undefined;
}
