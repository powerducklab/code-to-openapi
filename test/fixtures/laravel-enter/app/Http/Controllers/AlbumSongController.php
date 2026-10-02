<?php

namespace App\Http\Controllers;

use App\Models\Album;
use App\Models\Song;

class AlbumSongController extends Controller
{
    public function index(Album $album)
    {
        return response()->json($album->songs);
    }

    public function show(Album $album, Song $song)
    {
        return response()->json($song);
    }
}
