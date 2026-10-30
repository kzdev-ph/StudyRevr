What: Re-run Step 1 after Steps 6, 8 and 10; compare with the baseline; pick the 3 demo lessons.
For: sonnet-high-applier (real AI)
Depends on: 1, 6, 8, 10
Status: todo

# Step 14: Subjects after-run, comparison and demo lessons

**Run:** Step 1's runs again, on the 5 samples and any real files, and the same table side by side with the baseline.

**Success criteria, per lesson:**
- it reaches ready;
- equations are readable in `raw_text`, in sections and in cards;
- LaTeX leftovers = 0;
- at least 6 cards;
- clean questions at least 5 of 10;
- no card, option or true statement contradicts the lesson's numbers. Read every math card and option by hand and list any that are wrong.

**If a math or physics lesson has wrong numbers at Low:** run it once with `--thinking=medium` and record the result.

**Demo lessons:**
1. Use a fresh `DB_PATH` and `npm run study`.
2. Upload 3 demo lessons in admin: one math or physics, one chemistry, one history or literature.
3. `npm run quiz:check -- --db <file>` must say ≥ 5 for each.

**No code changes** except fixing a crash. Every other finding goes back to the boss.
Done-check: the comparison table and the demo database are ready.
