<?php

namespace App\Http\Controllers;

use Illuminate\Routing\Controller as BaseController;

class Controller extends BaseController
{
    /**
     * Base-class response helper: builds a download response that subclasses
     * return through $this->respondDownload(...).
     */
    protected function respondDownload(string $path)
    {
        return response()->download($path, 'invoice.pdf');
    }
}
