$inputFile = "index.html"
$content = [System.IO.File]::ReadAllText($inputFile, [System.Text.Encoding]::UTF8)

$lf = [char]10
$section_end = "      </section>"
$screen5_marker = "      <!-- SCREEN 5: WORD GROUPS"

# Find the orphan block - it starts right after first </section>
# The file uses LF line endings based on marker1b test
$pos1 = $content.IndexOf($section_end + $lf + $lf + "              <div class=`"guide-body-text`">")
if ($pos1 -lt 0) {
    # try variant with carriage return
    $pos1 = $content.IndexOf($section_end + "`r`n`r`n              <div class=`"guide-body-text`">")
}

Write-Host "Section end pos: $pos1"

if ($pos1 -ge 0) {
    $cutStart = $pos1 + $section_end.Length
    
    # Find where SCREEN 5 starts after the cut point
    $pos2 = $content.IndexOf($screen5_marker, $cutStart)
    Write-Host "Screen5 marker pos: $pos2"
    
    if ($pos2 -ge 0) {
        $before = $content.Substring(0, $cutStart)
        $after = $content.Substring($pos2)
        $newContent = $before + $lf + $lf + "      " + $after.TrimStart()
        [System.IO.File]::WriteAllText($inputFile, $newContent, [System.Text.Encoding]::UTF8)
        Write-Host "Done! File cleaned up."
        Write-Host "New length: $($newContent.Length) chars"
    } else {
        Write-Host "SCREEN 5 not found after section end!"
    }
} else {
    Write-Host "Could not find section end + orphan pattern"
}
