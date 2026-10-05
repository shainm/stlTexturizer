# Builds icon.ico from the app logo, puts "BumpMesh (My Version)" shortcuts
# on the Desktop and in the Start menu (so Windows search finds it), and
# makes .bumpmesh project files open in it on double-click (current user only).
# Re-run after moving the checkout. Pin to taskbar: right-click the Start-menu
# entry > Pin to taskbar (Windows doesn't let scripts pin).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$ico  = Join-Path $here 'icon.ico'

# ICO with PNG frames (Windows Vista+), square-padded from logo.png.
$src = [System.Drawing.Image]::FromFile((Join-Path $root 'logo.png'))
$frames = foreach ($s in 256, 48, 32, 16) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'
  $k = [Math]::Min($s / $src.Width, $s / $src.Height)
  $w = [int]($src.Width * $k); $h = [int]($src.Height * $k)
  $g.DrawImage($src, [int](($s - $w) / 2), [int](($s - $h) / 2), $w, $h)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  ,@($s, $ms.ToArray())
}
$src.Dispose()
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $out
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$frames.Count)
$offset = 6 + 16 * $frames.Count
foreach ($f in $frames) {
  $d = if ($f[0] -ge 256) { 0 } else { $f[0] }
  $bw.Write([byte]$d); $bw.Write([byte]$d); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]$f[1].Length); $bw.Write([UInt32]$offset)
  $offset += $f[1].Length
}
foreach ($f in $frames) { $bw.Write([byte[]]$f[1]) }
[IO.File]::WriteAllBytes($ico, $out.ToArray())

$wsh = New-Object -ComObject WScript.Shell
$targets = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('Programs')
)
foreach ($dir in $targets) {
  $lnk = $wsh.CreateShortcut((Join-Path $dir 'BumpMesh (My Version).lnk'))
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $here 'launch.vbs') + '"'
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$ico,0"
  $lnk.Description = 'My BumpMesh (stlTexturizer) version from ' + $root
  $lnk.Save()
  Write-Host "Shortcut: $($lnk.FullName)"
}

# .bumpmesh → launch.vbs "%1" (HKCU, no admin needed)
$cls = 'HKCU:\Software\Classes'
$prog = 'BumpMesh.Project'
New-Item -Path "$cls\.bumpmesh" -Force | Out-Null
Set-ItemProperty -Path "$cls\.bumpmesh" -Name '(default)' -Value $prog
New-Item -Path "$cls\$prog\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$cls\$prog" -Name '(default)' -Value 'BumpMesh Project'
Set-ItemProperty -Path "$cls\$prog\DefaultIcon" -Name '(default)' -Value "$ico,0"
New-Item -Path "$cls\$prog\shell\open\command" -Force | Out-Null
$cmd = '"' + (Join-Path $env:WINDIR 'System32\wscript.exe') + '" "' + (Join-Path $here 'launch.vbs') + '" "%1"'
Set-ItemProperty -Path "$cls\$prog\shell\open\command" -Name '(default)' -Value $cmd
# Tell Explorer the associations changed.
Add-Type -Namespace Win32 -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);'
[Win32.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Host "Associated .bumpmesh with $cmd"
