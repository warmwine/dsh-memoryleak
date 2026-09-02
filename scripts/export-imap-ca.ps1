# export-imap-ca.ps1 —— 导出 Exchange/IMAP 服务器的证书链，喂给 Node
# （NODE_EXTRA_CA_CERTS）。解决「Outlook 能连、Node 报 unable to verify
#  the first certificate」：Windows 走自己的证书库并会按 AIA 自动补中间
# 证书，Node 只认自带 CA 库 + NODE_EXTRA_CA_CERTS 指向的文件。
#
# 用法（在运行 dsh web 的机器上）：
#   powershell -File scripts\export-imap-ca.ps1 邮件服务器主机名 [端口]
#   端口缺省 993。
#
# 做三件事：
#   1. TLS 连接服务器（忽略校验，只为了拿证书；不发任何凭证）
#   2. 用 Windows 的链构建（本机信任库 + AIA 自动下载中间证书）拼出完整链
#   3. 导出中间/根证书为 scripts\exchange-imap-ca.pem，并用 Node 按新
#      信任链自检一次（通过 = 重启 dsh web 后 /ml mail 必过证书关）
param(
  [Parameter(Mandatory = $true)] [string]$HostName,
  [int]$Port = 993
)
$ErrorActionPreference = 'Stop'

Write-Host "1/3 连接 $HostName`:$Port（忽略校验，只取证书）..."
$tcp = New-Object System.Net.Sockets.TcpClient
$tcp.Connect($HostName, $Port)
$ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, { param($sender, $certificate, $chain, $errors) return $true })
try {
  $ssl.AuthenticateAsClient($HostName)
} catch {
  Write-Host "❌ TLS 握手本身失败（这属于端口/协议层问题，不是证书信任问题）：$($_.Exception.Message)"
  Write-Host "   可先用 node scripts/probe-mail-tls.mjs $HostName $Port 分层定位。"
  $ssl.Dispose(); $tcp.Dispose()
  exit 1
}
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
$ssl.Dispose(); $tcp.Dispose()
Write-Host ("   服务器证书：{0}" -f $cert.Subject)
Write-Host ("   签发者：    {0}" -f $cert.Issuer)

Write-Host "2/3 用 Windows 链构建拼完整证书链（信任库 + AIA 补中间证书）..."
$chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
$chain.ChainPolicy.RevocationMode = 'NoCheck'
$chain.ChainPolicy.VerificationFlags = 'AllowUnknownCertificateAuthority'
$null = $chain.Build($cert)
$elements = @($chain.ChainElements | ForEach-Object { $_.Certificate })
if ($elements.Count -gt 1) {
  # 第 0 张是服务器证书自己；其余是中间 CA + 根 CA
  $toExport = @($elements | Select-Object -Skip 1)
} else {
  # 链里只有服务器证书自己：自签证书时它就是自己的锚，直接导出；
  # 不是自签则说明本机也没有这条链的任何一环，需要管理员提供 CA 证书。
  $toExport = @($elements[0])
  if ($cert.Subject -ne $cert.Issuer) {
    Write-Host "⚠️ 本机拿不到这条链的中间/根证书（信任库没有、AIA 也补不出来）。"
    Write-Host "   请向邮箱/域管理员要内部 CA 证书（.cer/.crt/.pem 均可），"
    Write-Host "   把内容追加到下面生成的文件末尾（一段 -----BEGIN CERTIFICATE----- 即一张）。"
  }
}

$out = Join-Path $PSScriptRoot 'exchange-imap-ca.pem'
$builder = New-Object System.Text.StringBuilder
foreach ($c in $toExport) {
  $b64 = [Convert]::ToBase64String($c.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert), 'InsertLineBreaks')
  [void]$builder.AppendLine('-----BEGIN CERTIFICATE-----')
  [void]$builder.AppendLine($b64)
  [void]$builder.AppendLine('-----END CERTIFICATE-----')
}
[System.IO.File]::WriteAllText($out, $builder.ToString())
Write-Host ("✅ 已导出 {0} 张证书 → {1}" -f $toExport.Count, $out)
foreach ($c in $toExport) { Write-Host ("   · " + $c.Subject) }

Write-Host "3/3 用 Node 按新信任链自检..."
$env:NODE_EXTRA_CA_CERTS = $out
$probe = @'
const tls = require("tls");
const [host, port] = [process.argv[1], Number(process.argv[2])];
const s = tls.connect({ host, port, servername: host, rejectUnauthorized: true }, () => {
  console.log("✅ Node 已信任这条链（握手 + 证书校验通过）。重启 dsh web 后 /ml mail 试登陆即可过证书关。");
  s.end(); process.exit(0);
});
s.on("error", (e) => { console.log("❌ Node 仍不信任：" + e.message); process.exit(1); });
'@
$tmp = Join-Path $env:TEMP 'ml-ca-selfcheck.js'
[System.IO.File]::WriteAllText($tmp, $probe)
try {
  node $tmp $HostName $Port
} catch {
  Write-Host "（自检跳过：找不到 node 命令——手动用 node scripts/probe-mail-tls.mjs 验证亦可）"
}
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "下一步（让 dsh web 里的 /ml mail 用上这条信任链）："
Write-Host ("  1) setx NODE_EXTRA_CA_CERTS `"{0}`"" -f $out)
Write-Host "  2) 完全退出并重启 dsh web（必须从新开的终端启动——setx 只对新进程生效）"
Write-Host "  3) 重启后执行 /ml mail setup 重新试登陆"
