param(
    [string]$Raw = "$PSScriptRoot\..\content\vendor\chess.js.raw",
    [string]$Out = "$PSScriptRoot\..\content\vendor\chess.global.js"
)

$src = Get-Content $Raw -Raw

$header = @'
/* chess.js v1.4.0 - https://github.com/jhlywa/chess.js - BSD-2-Clause */
(function (global) {
  var module = { exports: {} };
  var exports = module.exports;
'@

$footer = @'
  global.Chess = module.exports.Chess;
})(typeof globalThis !== 'undefined' ? globalThis : this);
'@

Set-Content -Path $Out -Value ($header + $src + $footer) -Encoding UTF8
Write-Output "wrote $Out"
