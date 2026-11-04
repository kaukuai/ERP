$ErrorActionPreference = 'Stop'
$PackageRoot = Split-Path -Parent $PSScriptRoot
$NodePath = Join-Path $PackageRoot 'runtime\node.exe'
$WorkerPath = Join-Path $PackageRoot 'app\scripts\backup-service.mjs'
if (!(Test-Path -LiteralPath $NodePath) -or !(Test-Path -LiteralPath $WorkerPath)) { throw 'Please run this from the extracted Windows package.' }
$TaskTime = Read-Host 'Daily backup time (HH:mm, default 18:00)'
if (!$TaskTime) { $TaskTime = '18:00' }
$ParsedTime = [DateTime]::ParseExact($TaskTime, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
$CopyDestination = Read-Host 'Optional second drive/network folder for an extra copy (Enter to skip)'
if ($CopyDestination -match '["\r\n]') { throw 'The folder name contains unsupported characters.' }
$TaskArguments = '"' + $WorkerPath + '" --retain 30'
if ($CopyDestination) { $TaskArguments += ' --destination "' + [IO.Path]::GetFullPath($CopyDestination) + '"' }
$TaskAction = New-ScheduledTaskAction -Execute $NodePath -Argument $TaskArguments
$TaskTrigger = New-ScheduledTaskTrigger -Daily -At $ParsedTime
$TaskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$TaskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$TaskPrincipal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'ERP-Local-Backup' -Action $TaskAction -Trigger $TaskTrigger -Settings $TaskSettings -Principal $TaskPrincipal -Description 'Daily validated ERP company backups, keep 30 groups.' -Force | Out-Null
Write-Host 'Backup schedule installed. The computer must be awake and the user signed in. Re-run after moving/updating the program folder.'
Read-Host 'Press Enter to close'
