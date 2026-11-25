param([Parameter(Mandatory=$true)][string]$Path,[switch]$Thumbnail)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapTransform,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapEncoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime]
$null=[Windows.Data.Pdf.PdfPageRenderOptions,Windows.Data.Pdf,ContentType=WindowsRuntime]
$methods=[System.WindowsRuntimeSystemExtensions].GetMethods()
$generic=$methods | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1') } | Select-Object -First 1
$action=$methods | Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function Await($operation,[Type]$type){
    $task=$generic.MakeGenericMethod($type).Invoke($null,@($operation))
    $task.GetAwaiter().GetResult()
}
function AwaitAction($operation){
    $task=$action.Invoke($null,@($operation))
    $task.GetAwaiter().GetResult()
}
if($Thumbnail){
    $file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
    $pdf=Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
    if($pdf.PageCount -eq 0){throw 'PDF contains no pages'}
    $page=$pdf.GetPage(0)
    $stream=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    try{
        $options=New-Object Windows.Data.Pdf.PdfPageRenderOptions
        $options.DestinationWidth=[uint32][Math]::Max(1,[Math]::Min(320,320*$page.Size.Width/[Math]::Max(1,$page.Size.Height)))
        $options.DestinationHeight=[uint32][Math]::Max(1,[Math]::Min(320,320*$page.Size.Height/[Math]::Max(1,$page.Size.Width)))
        $options.BitmapEncoderId=[Windows.Graphics.Imaging.BitmapEncoder]::PngEncoderId
        AwaitAction ($page.RenderToStreamAsync($stream,$options))
        if($stream.Size -gt 1048576){throw 'Thumbnail exceeds limit'}
        $reader=New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
        try{
            $count=Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32])
            $bytes=New-Object byte[] $count
            $reader.ReadBytes($bytes)
            [Convert]::ToBase64String($bytes)
        }finally{$reader.Dispose()}
    }finally{$stream.Dispose();$page.Dispose()}
    exit
}
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if($null -eq $engine){throw 'Windows OCR language pack unavailable'}
function ReadText($stream){
    $decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    if($decoder.PixelWidth -gt 16000 -or $decoder.PixelHeight -gt 16000 -or ([double]$decoder.PixelWidth*$decoder.PixelHeight) -gt 64000000){throw 'Image dimensions exceed limit'}
    $transform=New-Object Windows.Graphics.Imaging.BitmapTransform
    $ratio=[Math]::Min(1.0,[double][Windows.Media.Ocr.OcrEngine]::MaxImageDimension/[Math]::Max($decoder.PixelWidth,$decoder.PixelHeight))
    $transform.ScaledWidth=[uint32][Math]::Max(1,[Math]::Floor($decoder.PixelWidth*$ratio))
    $transform.ScaledHeight=[uint32][Math]::Max(1,[Math]::Floor($decoder.PixelHeight*$ratio))
    $bitmap=Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore,$transform,[Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,[Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try{
        $result=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        return (($result.Lines | ForEach-Object {$_.Text}) -join [Environment]::NewLine)
    }finally{$bitmap.Dispose()}
}
$file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$parts=New-Object 'System.Collections.Generic.List[string]'
$total=1
if([IO.Path]::GetExtension($Path).ToLowerInvariant() -eq '.pdf'){
    $pdf=Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
    $total=[int]$pdf.PageCount
    for($i=0;$i -lt [Math]::Min(10,$total);$i++){
        $page=$pdf.GetPage([uint32]$i)
        $stream=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
        try{
            $options=New-Object Windows.Data.Pdf.PdfPageRenderOptions
            $options.DestinationWidth=[uint32][Math]::Max(1,[Math]::Min(1600,1600*$page.Size.Width/[Math]::Max(1,$page.Size.Height)))
            $options.DestinationHeight=[uint32][Math]::Max(1,[Math]::Min(1600,1600*$page.Size.Height/[Math]::Max(1,$page.Size.Width)))
            AwaitAction ($page.RenderToStreamAsync($stream,$options))
            $stream.Seek(0)
            $parts.Add((ReadText $stream))
        }finally{$stream.Dispose();$page.Dispose()}
    }
}else{
    $stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try{$parts.Add((ReadText $stream))}finally{$stream.Dispose()}
}
@{text=($parts -join ([Environment]::NewLine+[Environment]::NewLine));pages=$parts.Count;total=$total;language=$engine.RecognizerLanguage.LanguageTag} | ConvertTo-Json -Compress
