<?php
// Original routes, handlers, repository, DTOs and custom error handler are run.
// Dependency injection is the only replacement (a two-service explicit map).
$root = $argv[1]; $dependencies = $argv[2]; $output = $argv[3];
$packages = json_decode(file_get_contents($dependencies . '/manifest.json'), true, 512, JSON_THROW_ON_ERROR);
$prefixes = ['App\\' => [$root . '/src/']]; $files = [];
foreach ($packages as $package) {
    // macOS /tmp is a symlink; the WASM filesystem exposes /private/tmp.
    if (!is_dir($package['directory']) && str_starts_with($package['directory'], '/tmp/')) $package['directory'] = '/private' . $package['directory'];
    foreach ($package['autoload']['psr-4'] ?? [] as $prefix => $paths) {
        foreach ((array) $paths as $path) $prefixes[$prefix][] = $package['directory'] . '/' . $path . '/';
    }
    foreach ($package['autoload']['files'] ?? [] as $file) $files[] = $package['directory'] . '/' . $file;
}
spl_autoload_register(function ($class) use ($prefixes) {
    foreach ($prefixes as $prefix => $directories) {
        if (strpos($class, $prefix) !== 0) continue;
        foreach ($directories as $directory) {
            $file = $directory . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
            if (is_file($file)) { require $file; return; }
        }
    }
});
foreach ($files as $file) require_once $file;
$logger = new Psr\Log\NullLogger();
$repository = new App\Infrastructure\Persistence\User\InMemoryUserRepository();
$services = [
    App\Application\Actions\User\ListUsersAction::class => new App\Application\Actions\User\ListUsersAction($logger, $repository),
    App\Application\Actions\User\ViewUserAction::class => new App\Application\Actions\User\ViewUserAction($logger, $repository),
];
$container = new class($services) implements Psr\Container\ContainerInterface {
    private array $services;
    public function __construct(array $services) { $this->services = $services; }
    public function has(string $id): bool { return isset($this->services[$id]); }
    public function get(string $id) { return $this->services[$id]; }
};
Slim\Factory\AppFactory::setContainer($container);
$app = Slim\Factory\AppFactory::create();
$routes = require $root . '/app/routes.php'; $routes($app);
$app->addRoutingMiddleware();
$errorHandler = new App\Application\Handlers\HttpErrorHandler($app->getCallableResolver(), $app->getResponseFactory());
$app->addErrorMiddleware(false, false, false)->setDefaultErrorHandler($errorHandler);
$factory = new Slim\Psr7\Factory\ServerRequestFactory(); $results = [];
foreach ([['GET','/',200],['OPTIONS','/anything',200],['GET','/users',200],['GET','/users/1',200],['GET','/users/1abc',200],['GET','/users/9999',404],['GET','/users/not-a-number',404],['GET','/users/',405],['POST','/users',405]] as [$method,$path,$expected]) {
    $response = $app->handle($factory->createServerRequest($method, 'http://localhost' . $path));
    if ($response->getStatusCode() !== $expected) throw new RuntimeException($method . ' ' . $path . ': ' . $response->getStatusCode());
    $body = (string) $response->getBody();
    $results[] = ['method'=>$method,'path'=>$path,'status'=>$expected,'mediaType'=>$response->getHeaderLine('Content-Type'),'body'=>json_decode($body,true) ?? $body];
}
$registered = array_map(fn($route) => ['methods'=>$route->getMethods(),'pattern'=>$route->getPattern()], $app->getRouteCollector()->getRoutes());
file_put_contents($output, json_encode(['php'=>PHP_VERSION,'packages'=>array_map(fn($package)=>['name'=>$package['name'],'version'=>$package['version'],'reference'=>$package['reference']],$packages),'routes'=>array_values($registered),'probes'=>$results],JSON_PRETTY_PRINT|JSON_THROW_ON_ERROR));
echo count($results) . " original Slim handler probes passed\n";
