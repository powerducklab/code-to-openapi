<?php
// Native serialization oracle; not generated from scanner output.
class Secret { public string $name='visible'; private string $password='hidden'; }
class ParentDto {public string $base='base';}
class Payload extends ParentDto {
 public string $first='first', $later;
 public static string $global='not serialized';
 public $dynamic;
 public function __construct(public ?Secret $child=null){}
}
$cases = ['empty'=>new Payload(), 'nested'=>new Payload(new Secret())];
$actual = json_decode(json_encode($cases, JSON_THROW_ON_ERROR), true, 512, JSON_THROW_ON_ERROR);
$expected = ['empty'=>['base'=>'base','first'=>'first','dynamic'=>null,'child'=>null], 'nested'=>['base'=>'base','first'=>'first','dynamic'=>null,'child'=>['name'=>'visible']]];
if ($actual !== $expected) throw new RuntimeException('Native JSON field mismatch: '.json_encode($actual));
file_put_contents($argv[1], json_encode(['php'=>PHP_VERSION,'cases'=>$actual],JSON_PRETTY_PRINT|JSON_THROW_ON_ERROR));
echo "2 native PHP DTO serialization probes passed\n";
