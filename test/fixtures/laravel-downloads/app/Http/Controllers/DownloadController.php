<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\Response;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Symfony\Component\HttpFoundation\StreamedResponse;

class DownloadController extends Controller
{
    // response()->download($path, $name) — already covered, here for completeness.
    public function helperDownload()
    {
        return response()->download('/storage/reports/sum.csv', 'sum.csv');
    }

    // Response::make($content, $status) facade.
    public function facadeMake()
    {
        return Response::make('raw body', 200);
    }

    // Response::download($path, $name) facade.
    public function facadeDownload()
    {
        return Response::download('/storage/files/album.zip', 'album.zip');
    }

    // Response::streamDownload(closure, $name) facade.
    public function facadeStream()
    {
        return Response::streamDownload(function () {
            echo 'streamed body';
        }, 'export.csv');
    }

    // response()->streamDownload(closure, $name).
    public function helperStream()
    {
        return response()->streamDownload(function () {
            echo 'csv';
        }, 'data.csv');
    }

    // response()->file($path) — serve a static file inline.
    public function file()
    {
        return response()->file('/var/app/public/manifest.json');
    }

    // response()->make($string, $status).
    public function make()
    {
        return response()->make($this->renderCsv(), 200);
    }

    // new BinaryFileResponse($path) returned directly.
    public function binaryFile()
    {
        return new BinaryFileResponse('/var/app/public/qr.png');
    }

    // new StreamedResponse(closure, $status, $headers) assigned then returned.
    public function streamed()
    {
        $response = new StreamedResponse(function () {
            echo 'streamed csv';
        }, 200, ['Content-Type' => 'text/csv']);

        return $response;
    }

    // $this->respondXxx(...) resolved in the base controller.
    public function viaBaseHelper()
    {
        return $this->respondDownload('/storage/invoices/1.pdf');
    }

    private function renderCsv(): string
    {
        return 'a,b';
    }
}
