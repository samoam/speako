# Lists audio input device names exactly as the legacy Windows MME API reports
# them — this is what SoX's `-t waveaudio` driver sees, which is NOT the same
# as the friendly names shown in Settings > Sound (and is truncated to 31
# characters, a hard MME limit). Use the printed name verbatim as
# MIC_AUDIO_DEVICE / SYSTEM_AUDIO_DEVICE in .env.
#
# Run with: powershell -ExecutionPolicy Bypass -File scripts/list-audio-devices.ps1

$sig = @'
[System.Runtime.InteropServices.DllImport("winmm.dll")]
public static extern int waveInGetNumDevs();

[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet=System.Runtime.InteropServices.CharSet.Ansi)]
public struct WAVEINCAPS {
    public short wMid;
    public short wPid;
    public int vDriverVersion;
    [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.ByValTStr, SizeConst=32)]
    public string szPname;
    public int dwFormats;
    public short wChannels;
    public short wReserved1;
}

[System.Runtime.InteropServices.DllImport("winmm.dll", CharSet=System.Runtime.InteropServices.CharSet.Ansi)]
public static extern int waveInGetDevCaps(System.IntPtr uDeviceID, ref WAVEINCAPS pwic, int cbwic);
'@
Add-Type -MemberDefinition $sig -Name WaveNative -Namespace Speako

$count = [Speako.WaveNative]::waveInGetNumDevs()
Write-Output "Input (recording) devices visible to SoX: $count"
for ($i = 0; $i -lt $count; $i++) {
    $caps = New-Object Speako.WaveNative+WAVEINCAPS
    [Speako.WaveNative]::waveInGetDevCaps([IntPtr]$i, [ref]$caps, [System.Runtime.InteropServices.Marshal]::SizeOf($caps)) | Out-Null
    Write-Output "[$i] $($caps.szPname)"
}
