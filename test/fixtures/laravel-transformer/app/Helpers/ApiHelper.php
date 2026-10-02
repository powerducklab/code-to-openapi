<?php

namespace App\Helpers;

class ApiHelper
{
    public static function formatStandardApiResponse($status, $payload = null, $messages = null): array
    {
        $array['status'] = $status;
        $array['messages'] = $messages;
        $array['payload'] = $payload;

        return $array;
    }
}
