<?php

namespace App\Http\Controllers\API\Auth\TwoFactor;

class EnrollController extends Controller
{
    public function __invoke()
    {
        return response()->json([
            'provisioning_uri' => $this->twoFactorAuth->enroll(),
        ]);
    }
}
