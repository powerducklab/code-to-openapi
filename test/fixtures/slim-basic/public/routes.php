<?php

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

return function (App $app) {
    $app->get('/users/{id}', function (Request $request, Response $response, array $args) {
        $name = $request->getQueryParams()['name'] ?? 'anon';
        $response->getHeaderLine('X-Trace-Id');
        $payload = ['id' => (int) $args['id'], 'name' => $name];
        return $response->withJson($payload, 200);
    });

    $app->post('/users', function (Request $request, Response $response) {
        $body = $request->getParsedBody();
        return $response->withJson(['created' => true, 'email' => $body['email']], 201);
    });

    $app->group('/api/v1', function () use ($app) {
        $app->put('/items/{id}', function (Request $request, Response $response, array $args) {
            return $response->withJson(['ok' => true, 'id' => (int) $args['id']]);
        });

        $app->delete('/items/{id}', function (Request $request, Response $response, array $args) {
            return $response->withStatus(204);
        });
    });

    $app->get('/report.csv', function (Request $request, Response $response) {
        $response->getBody()->write('id,name');
        return $response->withHeader('Content-Type', 'application/octet-stream');
    });
};
