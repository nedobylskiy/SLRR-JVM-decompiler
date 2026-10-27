# System scripts source/class audit

This audit used a `sources/system/Scripts` tree of 73 Java-like source files and its matching `game/system/Scripts` tree of 73 TUFA `.class` files. Game files are not included in this repository.

## Results

- The 73 TUFA files contain 87 class blobs and 491 method bodies. Strict parsing and decompilation completed with no fallback diagnostics.
- 77 class blobs could be paired with declarations in the supplied source files. The others are secondary or compiled-only classes and cannot be compared to a source declaration here.
- The only confirmed decompiler semantic error in `Vector` was that statement-form TUFA tags 24 (`postdec`) and 26 (`predec`) were printed as increments. Tag 25 (`preinc`) also had the wrong prefix position in statement form. These mappings are fixed and covered by a four-tag synthetic test. The system classes contain nine tag-24 and five tag-26 occurrences, so this was not unique to `Vector`.
- After that fix, operator counts match for all paired methods with the same signature except `String.timeToString(float,int)` and `Config(int)`. The corresponding source and binary bodies are different versions: the compiled `String` method handles negative times and a sign flag that its supplied source lacks; `Config` has an additional assignment.
- Several declaration differences are likewise version differences. For example, the supplied `Vector3.java` declares two `rotate` overloads returning `void`, while the `.class` descriptors return `Vector3`; the binary also contains `dot`, `save`, and `load`, which the supplied source does not define. Those descriptors come directly from TUFA and must not be changed to match an older source file.

## Interpretation and next checks

Successful parsing shows that TUFA structures and control-flow jumps are accepted. It does not prove semantic equivalence. The paired sources provide a stronger oracle, but only where signatures and bodies belong to the same version.

Next comparisons should use matched-version source/class pairs, normalize local and parameter names, and compare expression operators plus execution results for focused methods. Prioritize branch reconstruction, short-circuit evaluation, compound assignments, and overloaded calls. Parameter names, comments, and whether a source-level loop was written as `for` or `while` are generally not recoverable from these `.class` files.
