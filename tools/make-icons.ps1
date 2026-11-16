# Generates the extension PNG icons from a vector-style drawing.
# Usage: powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outDir = Join-Path $root 'icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$master = 512
$bmp = New-Object System.Drawing.Bitmap($master, $master)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$radius = 104
$body = New-RoundedPath 12 12 ($master - 24) ($master - 24) $radius

$bgRect = New-Object System.Drawing.RectangleF(0, 0, $master, $master)
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $bgRect,
  [System.Drawing.Color]::FromArgb(255, 28, 38, 53),
  [System.Drawing.Color]::FromArgb(255, 8, 12, 18),
  55.0
)
$g.FillPath($bg, $body)
$bg.Dispose()

# Faint board checker in the background.
$g.SetClip($body)
$cell = 64
for ($rank = 0; $rank -lt 8; $rank++) {
  for ($file = 0; $file -lt 8; $file++) {
    if ((($rank + $file) % 2) -eq 0) {
      $alpha = 8
      $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($alpha, 255, 255, 255))
      $g.FillRectangle($brush, $file * $cell, $rank * $cell, $cell, $cell)
      $brush.Dispose()
    }
  }
}
$g.ResetClip()

# Warm accent glow in the upper-right corner.
$glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowPath.AddEllipse(280, -150, 420, 420)
$glow = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
$glow.CenterColor = [System.Drawing.Color]::FromArgb(46, 255, 176, 46)
$glow.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 176, 46))
$g.FillPath($glow, $glowPath)
$glow.Dispose()
$glowPath.Dispose()

# Amber move arrow, drawn behind the knight.
$arrowPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 255, 176, 46), 30)
$arrowPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$arrowPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawLine($arrowPen, 314, 414, 424, 304)
$arrowPen.Dispose()
$head = New-Object System.Drawing.Drawing2D.GraphicsPath
$head.AddPolygon(@(
  (New-Object System.Drawing.PointF(444, 284)),
  (New-Object System.Drawing.PointF(396, 296)),
  (New-Object System.Drawing.PointF(432, 332))
))
$headBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 176, 46))
$g.FillPath($headBrush, $head)
$headBrush.Dispose()
$head.Dispose()

# White knight.
$family = New-Object System.Drawing.FontFamily('Segoe UI Symbol')
$font = New-Object System.Drawing.Font($family, 326, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = New-Object System.Drawing.RectangleF(0, -14, $master, $master)
$shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(115, 0, 0, 0))
$g.DrawString([string][char]0x265E, $font, $shadowBrush, (New-Object System.Drawing.RectangleF(8, -6, $master, $master)), $format)
$shadowBrush.Dispose()
$g.DrawString([string][char]0x265E, $font, [System.Drawing.Brushes]::White, $textRect, $format)

# Inner border + outer rim.
$innerPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(52, 255, 255, 255), 3)
$g.DrawPath($innerPen, $body)
$innerPen.Dispose()
$rimPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 255, 176, 46), 5)
$g.DrawPath($rimPen, $body)
$rimPen.Dispose()

$font.Dispose()
$family.Dispose()
$body.Dispose()
$g.Dispose()

foreach ($size in @(16, 32, 48, 128)) {
  $scaled = New-Object System.Drawing.Bitmap($size, $size)
  $sg = [System.Drawing.Graphics]::FromImage($scaled)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $sg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $sg.Clear([System.Drawing.Color]::Transparent)
  $sg.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  $sg.Dispose()
  $path = Join-Path $outDir ("icon-{0}.png" -f $size)
  $scaled.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $scaled.Dispose()
}

# Keep a large master for the store / README.
$bmp.Save((Join-Path $outDir 'icon-512.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "Icons written to $outDir"
