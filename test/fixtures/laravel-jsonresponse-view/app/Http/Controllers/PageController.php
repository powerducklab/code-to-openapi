<?php

namespace App\Http\Controllers;

use Illuminate\View\View;
use Illuminate\Http\RedirectResponse;

class PageController extends Controller
{
    public function show(): View
    {
        return view('pages.show')->with('item', new \stdClass);
    }

    public function landing(): View
    {
        return view('pages.landing', ['title' => 'Welcome']);
    }

    public function goHome(): RedirectResponse
    {
        return redirect()->route('home')->with('status', 'ok');
    }
}
