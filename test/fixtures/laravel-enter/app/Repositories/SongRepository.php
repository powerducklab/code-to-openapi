<?php

namespace App\Repositories;

use App\Models\Song;

class SongRepository
{
    public function getAll()
    {
        return Song::all();
    }
}
