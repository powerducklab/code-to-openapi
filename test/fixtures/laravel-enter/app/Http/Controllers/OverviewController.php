<?php

namespace App\Http\Controllers;

use App\Repositories\SongRepository;

class OverviewController extends Controller
{
    public function __invoke(SongRepository $repository)
    {
        return response()->json([
            'songs' => $repository->getAll(),
        ]);
    }
}
