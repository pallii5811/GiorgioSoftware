try {
  $r = Invoke-WebRequest -Uri 'https://giorgio-software.vercel.app/api/sanita?region=Campania' -TimeoutSec 40 -UseBasicParsing
  Write-Output ('HTTP ' + $r.StatusCode)
  $c = $r.Content
  Write-Output $c.Substring(0, [Math]::Min(300, $c.Length))
} catch {
  Write-Output ('ERR ' + $_.Exception.Message)
}
