<?php
/** Original controllers + native Symfony AttributeClassLoader. Business handlers are not executed. */
namespace Symfony\Bundle\FrameworkBundle\Controller { abstract class AbstractController {} }
namespace {
$root=$argv[1];$packages=$argv[2];$output=$argv[3];
spl_autoload_register(function($name)use($root,$packages){
 foreach(['Symfony\\Component\\Security\\Http\\'=>$packages.'/security-http/','Symfony\\Component\\Routing\\'=>$packages.'/routing/','Symfony\\Component\\Config\\'=>$packages.'/config/','App\\'=>$root.'/src/']as$prefix=>$dir){
  if(str_starts_with($name,$prefix)){$file=$dir.str_replace('\\','/',substr($name,strlen($prefix))).'.php';if(is_file($file))require $file;return;}
 }
});
$loader=new class extends \Symfony\Component\Routing\Loader\AttributeClassLoader {
 protected function configureRoute(\Symfony\Component\Routing\Route $route,\ReflectionClass $class,\ReflectionMethod $method,object $attr):void{$route->setDefault('_controller',$class->getName().'::'.$method->getName());}
};
$all=new \Symfony\Component\Routing\RouteCollection();
foreach(new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root.'/src/Controller'))as$file){
 if(!$file->isFile()||$file->getExtension()!=='php')continue;
 $relative=substr($file->getPathname(),strlen($root.'/src/'));$class='App\\'.str_replace('/','\\',substr($relative,0,-4));
 $all->addCollection($loader->load($class));
}
// Apply the independently inspected import prefix/default from config/routes.yaml.
$all->addPrefix('/{_locale}');$all->addDefaults(['_locale'=>'en']);
$rows=[];
foreach($all as$name=>$route){$rows[]=['name'=>$name,'path'=>$route->getPath(),'methods'=>$route->getMethods(),'requirements'=>$route->getRequirements(),'defaults'=>$route->getDefaults(),'variables'=>$route->compile()->getVariables()];}
file_put_contents($output,json_encode($rows,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES));echo count($rows)." routes\n";
}
