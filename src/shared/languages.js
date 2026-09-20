'use strict';

/**
 * Programming-language resolution for the "solve what's on my screen" panel.
 *
 * The input is a free-text box, deliberately: you type "pyhton" or "golang"
 * or "c sharp" mid-interview and it lands on the right thing. Nothing here
 * ever rejects input — an unknown string is passed through to the model
 * as-typed, because a list that says "no" to a language it hasn't heard of
 * is worse than one that guesses.
 *
 * Loaded twice: `require`d by the main process, and as a plain <script> by
 * the overlay (which is contextIsolated and cannot require). Hence the UMD
 * tail at the bottom.
 */

// Everything lives inside this IIFE. In the overlay this file is a plain
// <script>, so a bare top-level `function matchLanguage` would land on
// `window` and collide with overlay.js's own binding of the same name —
// which is a parse error that kills the whole overlay, silently.
const API = (() => {
  // Canonical name -> aliases people actually type.
  const LANGUAGES = {
    'Python': ['py', 'python2', 'python3', 'py3', 'cpython', 'pythonic'],
    'JavaScript': ['js', 'node', 'nodejs', 'node.js', 'ecmascript', 'es6', 'vanilla js'],
    'TypeScript': ['ts', 'tsx', 'typscript'],
    'Java': ['jdk', 'java8', 'java11', 'java17', 'java21'],
    'C': ['ansi c', 'c99', 'c11', 'c17', 'clang'],
    'C++': ['cpp', 'cplusplus', 'c plus plus', 'cxx', 'c++11', 'c++14', 'c++17', 'c++20', 'c++23', 'stl'],
    'C#': ['csharp', 'c sharp', 'cs', 'dotnet', '.net', 'net core'],
    'Go': ['golang', 'go lang'],
    'Rust': ['rs', 'rst', 'rustlang', 'rusty'],
    'Ruby': ['rb', 'ruby on rails', 'rails'],
    'PHP': ['php8', 'php7', 'laravel'],
    'Swift': ['swiftui', 'swift5'],
    'Kotlin': ['kt', 'kotlin jvm'],
    'Scala': ['scala3', 'scala2'],
    'R': ['rlang', 'r language', 'rstats'],
    'MATLAB': ['matlab script', 'mathworks'],
    'Objective-C': ['objc', 'objective c', 'obj-c', 'obj c'],
    'Perl': ['perl5', 'perl6'],
    'Lua': ['luajit'],
    'Haskell': ['hs', 'ghc'],
    'Elixir': ['ex', 'exs', 'phoenix'],
    'Erlang': ['erl', 'beam'],
    'Clojure': ['clj', 'cljs', 'clojurescript'],
    'F#': ['fsharp', 'f sharp'],
    'OCaml': ['ocml', 'caml', 'ml'],
    'Dart': ['flutter'],
    'Julia': ['jl'],
    'Groovy': ['gradle'],
    'Bash': ['sh', 'shell', 'shell script', 'shellscript', 'ksh', 'posix sh', 'terminal', 'bash script'],
    'Fish': ['fish shell'],
    'PowerShell': ['pwsh', 'ps1', 'power shell'],
    'SQL': ['mysql', 'postgres', 'postgresql', 'sqlite', 'tsql', 't-sql', 'plsql', 'pl/sql', 'mssql', 'sql server', 'oracle sql', 'ansi sql', 'bigquery', 'snowflake sql'],
    'HTML': ['html5', 'markup'],
    'CSS': ['css3', 'scss', 'sass', 'less', 'stylesheet', 'tailwind'],
    'Assembly': ['asm', 'x86', 'x86-64', 'x64 asm', 'arm asm', 'arm64', 'nasm', 'masm', 'riscv', 'risc-v', 'mips'],
    'VBA': ['visual basic for applications', 'excel macro', 'excel vba'],
    'Visual Basic': ['vb', 'vb.net', 'vbnet', 'vb6'],
    'Fortran': ['f90', 'f77', 'fortran90'],
    'COBOL': ['cobol85'],
    'Pascal': ['delphi', 'object pascal', 'free pascal'],
    'Ada': ['ada95', 'ada2012'],
    'Lisp': ['common lisp', 'clisp', 'sbcl'],
    'Scheme': ['racket', 'guile', 'mit scheme'],
    'Prolog': ['swi-prolog', 'swipl'],
    'Smalltalk': ['pharo', 'squeak'],
    'Tcl': ['tk', 'tcl/tk'],
    'Zig': ['ziglang'],
    'Nim': ['nimlang'],
    'Crystal': ['crystal lang'],
    'V': ['vlang'],
    'D': ['dlang'],
    'Solidity': ['sol', 'smart contract', 'evm'],
    'Vyper': ['vy'],
    'Move': ['move lang', 'sui move', 'aptos move'],
    'Cairo': ['starknet'],
    'GDScript': ['godot', 'gd script'],
    'AutoHotkey': ['ahk'],
    'AppleScript': ['apple script', 'osascript'],
    'ABAP': ['sap abap'],
    'Apex': ['salesforce apex'],
    'ActionScript': ['as3', 'flash'],
    'CoffeeScript': ['coffee'],
    'Elm': ['elm lang'],
    'PureScript': ['purs'],
    'ReasonML': ['reason', 'rescript'],
    'Idris': ['idris2'],
    'Agda': [],
    'Coq': ['rocq'],
    'Lean': ['lean4'],
    'Isabelle': [],
    'Verilog': ['systemverilog', 'sv', 'rtl'],
    'VHDL': ['vhsic'],
    'Chisel': [],
    'Bluespec': ['bsv'],
    'CUDA': ['cuda c', 'cuda c++', 'nvcc', 'gpu kernel'],
    'OpenCL': ['cl kernel'],
    'HLSL': ['directx shader'],
    'GLSL': ['opengl shader', 'shader'],
    'WGSL': ['webgpu shader'],
    'Metal': ['msl', 'metal shading language'],
    'Triton': ['openai triton'],
    'Mojo': ['mojo lang'],
    'Futhark': [],
    'Halide': [],
    'Q': ['kdb', 'kdb+', 'q lang'],
    'K': ['klang'],
    'J': ['jlang'],
    'APL': ['dyalog'],
    'BQN': [],
    'Octave': ['gnu octave'],
    'Maple': [],
    'Mathematica': ['wolfram', 'wolfram language', 'wl'],
    'SAS': ['sas script'],
    'SPSS': ['spss syntax'],
    'Stata': ['stata do'],
    'Awk': ['gawk', 'mawk', 'nawk'],
    'Sed': ['stream editor'],
    'Make': ['makefile', 'gnu make'],
    'CMake': ['cmakelists'],
    'Bazel': ['starlark', 'skylark', 'bzl'],
    'Nix': ['nixos', 'nix expression'],
    'Dockerfile': ['docker', 'containerfile'],
    'Terraform': ['hcl', 'tf', 'terraform hcl'],
    'Ansible': ['ansible playbook'],
    'Puppet': ['puppet manifest'],
    'Chef': ['chef recipe'],
    'Helm': ['helm chart'],
    'Kubernetes YAML': ['k8s', 'kubernetes', 'k8s manifest', 'kube yaml'],
    'YAML': ['yml'],
    'JSON': ['jsonc', 'json5'],
    'TOML': [],
    'XML': ['xsd', 'xslt', 'xsl'],
    'GraphQL': ['gql', 'graph ql'],
    'Protocol Buffers': ['protobuf', 'proto', 'proto3', 'grpc'],
    'Thrift': ['apache thrift'],
    'Avro': ['apache avro'],
    'Cypher': ['neo4j', 'neo4j cypher'],
    'SPARQL': ['rdf query'],
    'Gremlin': ['tinkerpop'],
    'MongoDB Query': ['mongo', 'mongodb', 'mql', 'mongo query', 'aggregation pipeline'],
    'Redis': ['redis commands', 'redis cli'],
    'Elasticsearch DSL': ['elastic', 'elasticsearch', 'es query', 'opensearch'],
    'DAX': ['power bi dax'],
    'M': ['power query', 'power query m'],
    'Excel Formula': ['excel', 'spreadsheet formula', 'google sheets', 'sheets formula'],
    'LaTeX': ['tex', 'latex2e', 'pdflatex'],
    'Markdown': ['md', 'mdx', 'commonmark'],
    'reStructuredText': ['restructuredtext', 'rest markup'],
    'AsciiDoc': ['adoc'],
    'Racket': ['plt scheme'],
    'Hack': ['hacklang'],
    'Ballerina': [],
    'Pony': ['ponylang'],
    'Chapel': [],
    'X10': [],
    'Eiffel': [],
    'Modula-2': ['modula'],
    'Oberon': [],
    'Algol': ['algol60', 'algol68'],
    'BASIC': ['qbasic', 'gwbasic', 'quickbasic'],
    'Logo': ['turtle graphics'],
    'Forth': ['gforth'],
    'Rexx': ['arexx'],
    'PL/I': ['pl1'],
    'RPG': ['rpgle', 'ibm rpg'],
    'JCL': ['job control language'],
    'Batch': ['bat', 'cmd', 'batch file', 'dos batch', 'windows batch'],
    'Nushell': ['nu'],
    'Xonsh': [],
    'Jsonnet': [],
    'Dhall': [],
    'CUE': ['cuelang'],
    'Rego': ['opa', 'open policy agent'],
    'Starlark': ['bzl lang'],
    'Vale': [],
    'Zsh': ['z shell', 'zshrc'],
    'Vimscript': ['vim', 'vimrc', 'vim9script'],
    'Emacs Lisp': ['elisp', 'emacs'],
    'Nginx Config': ['nginx', 'nginx conf'],
    'Apache Config': ['htaccess', 'apache conf'],
    'Regex': ['regexp', 'regular expression', 'pcre'],
    'Brainfuck': ['bf'],
    'Befunge': [],
    'Whitespace': [],
    'Malbolge': [],
    'Piet': [],
    'INTERCAL': [],
    'LOLCODE': [],
    'Shakespeare': ['spl'],
    'Chef Lang': [],
    'ChucK': [],
    'SuperCollider': ['sclang'],
    'Faust': [],
    'Csound': [],
    'Max/MSP': ['max msp', 'maxmsp'],
    'Pure Data': ['pd'],
    'Sonic Pi': [],
    'Processing': ['p5', 'p5.js', 'processing sketch'],
    'OpenSCAD': ['scad'],
    'G-code': ['gcode', 'cnc'],
    'Ladder Logic': ['plc', 'ladder'],
    'Structured Text': ['st plc', 'iec 61131'],
    'LabVIEW': ['labview g'],
    'Simulink': [],
    'Modelica': [],
    'AMPL': [],
    'GAMS': [],
    'ZIMPL': [],
    'MiniZinc': ['minizinc model'],
    'Alloy': ['alloy model'],
    'TLA+': ['tla', 'tlaplus', 'pluscal'],
    'Promela': ['spin'],
    'Dafny': [],
    'Why3': [],
    'F*': ['fstar'],
    'ATS': [],
    'Mercury': [],
    'Curry': [],
    'Oz': ['mozart oz'],
    'Io': ['iolang'],
    'Factor': ['factorlang'],
    'Joy': [],
    'Cat': [],
    'Red': ['redlang'],
    'Rebol': [],
    'Icon': ['unicon'],
    'SNOBOL': ['snobol4'],
    'Boo': [],
    'Nemerle': [],
    'Cobra': [],
    'Genie': [],
    'Vala': ['valalang'],
    'Haxe': ['hx'],
    'Squirrel': ['nut'],
    'Wren': ['wrenlang'],
    'Janet': [],
    'Fennel': [],
    'Hy': ['hylang'],
    'Gleam': [],
    'Roc': ['roclang'],
    'Koka': [],
    'Unison': [],
    'Flix': [],
    'Grain': [],
    'Odin': ['odinlang'],
    'Jai': [],
    'Carbon': ['carbon lang'],
    'Hare': ['harelang'],
    'C3': ['c3lang'],
    'Beef': [],
    'Nelua': [],
    'Terra': [],
    'WebAssembly': ['wasm', 'wat', 'wasm text'],
    'eBPF': ['bpf', 'bcc', 'bpftrace'],
    'P4': ['p4lang'],
    'Pseudocode': ['pseudo code', 'pseudo', 'plain english', 'english'],
  };

  const DISPLAY = Object.keys(LANGUAGES);

  // Flat lookup: every canonical name and alias, normalised.
  const INDEX = new Map();
  for (const name of DISPLAY) {
    INDEX.set(normalize(name), name);
    for (const alias of LANGUAGES[name]) INDEX.set(normalize(alias), name);
  }

  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .trim()
      // Keep + and # — they are the whole difference between C, C++ and C#.
      .replace(/[^a-z0-9+#./\- ]/g, '')
      .replace(/\s+/g, ' ');
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    const curr = new Array(b.length + 1);

    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      prev = curr.slice();
    }
    return prev[b.length];
  }

  function similarity(a, b) {
    const longest = Math.max(a.length, b.length);
    return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
  }

  /*
   * Tie-break weight. Prefix scoring alone is length-based, which makes "ja"
   * resolve to Jai over Java and "p" to Perl over Python — technically
   * consistent, practically wrong. Someone typing two letters into a hurry
   * box during an interview means the common language.
   */
  const POPULAR = new Set([
    'Python', 'JavaScript', 'TypeScript', 'Java', 'C', 'C++', 'C#', 'Go',
    'Rust', 'Ruby', 'PHP', 'Swift', 'Kotlin', 'Scala', 'R', 'SQL', 'Bash',
    'HTML', 'CSS', 'MATLAB', 'Perl', 'Dart', 'Objective-C', 'Haskell',
    'Elixir', 'Lua', 'Julia', 'Assembly', 'PowerShell',
  ]);
  const boost = (name) => (POPULAR.has(name) ? 0.08 : 0);

  // Words that appear around a language name but never are one.
  const FILLER = new Set([
    'in', 'it', 'the', 'a', 'an', 'to', 'me', 'my', 'i', 'please', 'plz', 'pls',
    'solve', 'write', 'give', 'show', 'using', 'use', 'with', 'for', 'and', 'or',
    'do', 'this', 'that', 'want', 'need', 'code', 'coding', 'language', 'lang',
    'answer', 'solution', 'program', 'script', 'only', 'prefer', 'preferably',
  ]);

  /**
   * Best guess at what the user meant.
   *
   * Returns { name, exact, confidence, typed }. `name` is always usable:
   * on a miss it is the user's own text, title-cased, and `exact` is false.
   * That is the point — "Prolog dialect my professor invented" should still
   * reach the model rather than being silently rewritten to "Prolog".
   */
  function matchLanguage(input) {
    const typed = String(input || '').trim();
    const q = normalize(typed);

    if (!q) return { name: 'Python', exact: false, confidence: 0, typed: '' };

    // 1. Straight hit.
    const hit = INDEX.get(q);
    if (hit) return { name: hit, exact: true, confidence: 1, typed };

    // 2. "java script", "c plus plus" — spacing is not a real difference.
    const squashed = q.replace(/ /g, '');
    const squashedHit = INDEX.get(squashed);
    if (squashedHit) return { name: squashedHit, exact: true, confidence: 0.95, typed };

    // 3. A language name sitting inside a sentence. Longest non-filler word
    //    wins, so "modern c++" lands on C++ rather than on C.
    const words = q.split(' ').filter((w) => w && !FILLER.has(w));
    if (words.length && q.includes(' ')) {
      let pick = null;
      for (const w of words) {
        const m = INDEX.get(w);
        if (m && (!pick || w.length > pick.w.length)) pick = { name: m, w };
      }
      if (pick) return { name: pick.name, exact: false, confidence: 0.8, typed };
    }

    // 4. Prefixes and typos.
    let best = null;
    let bestScore = 0;

    for (const [key, name] of INDEX) {
      let score;
      if (key.startsWith(q)) {
        // "pyth" -> Python. Shorter completions win: "c" reaches C, not CSS.
        score = 0.9 - Math.min(0.25, (key.length - q.length) * 0.02);
      } else if (q.startsWith(key) && key.length >= 3 && q.length - key.length <= 3) {
        // "pythonic3" -> Python. Bounded, or "sol..." swallows whole sentences.
        score = 0.85 - (q.length - key.length) * 0.03;
      } else if (key.includes(q) && q.length >= 3) {
        score = 0.7 - Math.min(0.2, (key.length - q.length) * 0.02);
      } else {
        const sim = similarity(q, key);
        // Typo tolerance only. Below this it is a different word, not a typo.
        score = sim >= 0.62 ? sim * 0.8 : 0;
      }

      if (score > 0) score += boost(name);

      if (score > bestScore) {
        bestScore = score;
        best = name;
      }
    }

    if (best && bestScore >= 0.48) {
      return { name: best, exact: false, confidence: Number(bestScore.toFixed(2)), typed };
    }

    // Unknown — hand the model exactly what was typed.
    return {
      name: typed.replace(/\b[a-z]/g, (c) => c.toUpperCase()),
      exact: false,
      confidence: 0,
      typed,
    };
  }

  /** Type-ahead suggestions for the language box. */
  function suggestLanguages(input, limit = 6) {
    const q = normalize(input);
    if (!q) return DISPLAY.slice(0, limit);

    const scored = DISPLAY.map((name) => {
      const keys = [normalize(name), ...LANGUAGES[name].map(normalize)];
      let best = 0;
      for (const k of keys) {
        if (k === q) best = Math.max(best, 1);
        else if (k.startsWith(q)) best = Math.max(best, 0.9 - (k.length - q.length) * 0.01);
        else if (k.includes(q) && q.length >= 3) best = Math.max(best, 0.6);
        else best = Math.max(best, similarity(q, k) >= 0.6 ? similarity(q, k) * 0.7 : 0);
      }
      return { name, best: best > 0 ? best + boost(name) : 0 };
    })
      .filter((x) => x.best > 0.3)
      .sort((a, b) => b.best - a.best)
      .slice(0, limit)
      .map((x) => x.name);

    return scored;
  }

  return { LANGUAGES, DISPLAY, matchLanguage, suggestLanguages, normalize };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;           // main process
} else if (typeof window !== 'undefined') {
  window.Languages = API;         // overlay (contextIsolated, no require)
}
